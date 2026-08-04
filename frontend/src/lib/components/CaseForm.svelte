<script lang="ts">
import { Popover } from "bits-ui";
import { onDestroy, onMount, untrack } from "svelte";
import { ApiError, apiFetch } from "$lib/api/client.js";
import {
	normalizePersona,
	normalizeReferral,
	parseIntOrNull,
} from "$lib/case/draft.js";
import { buildHTMLForm, downloadForm } from "$lib/case/exportCase.js";
import { CaseGraph } from "$lib/case/graph.svelte.js";
import { CaseImportError, parseHTMLForm } from "$lib/case/importCase.js";
import { submitCase } from "$lib/case/submitCase.js";
import { useCaseVersionPoll } from "$lib/case/useCaseVersionPoll.svelte.js";
import { ADMIN_ROLE } from "$lib/constants.js";
import { session } from "$lib/session.svelte.js";
import type { Api } from "$lib/types.js";
import { type SaveResult, unsavedGuard } from "$lib/unsavedGuard.svelte.js";
import CaseConflictModal from "./CaseConflictModal.svelte";
import CaseGraphEditor from "./CaseGraphEditor.svelte";

const MAX_SIMULATION_DURATION = 120;

// Sourced straight from page.url.searchParams.get(...) by the routes that
// render this form — real URL query strings, never parsed to a number.
// Both are only ever interpolated into `/api/cases/${sourceCaseId}`.
type Props = {
	templateId?: string | null;
	editCaseId?: string | null;
};

let { templateId = null, editCaseId = null }: Props = $props();

const isEditMode = $derived(Boolean(editCaseId));
const sourceCaseId = $derived(editCaseId || templateId);
// Import is only offered on the blank "from scratch" new-case route
const canImport = $derived(!sourceCaseId);

let caseName = $state("");
let initialBrief = $state("");
let commonInformation = $state("");
let simulationDurationMinutes = $state<number | null>(null);
let accessCode = $state("");
const graph = new CaseGraph();

// Collaborators: access-control metadata, not case content — only ever
// populated in edit mode (see loadCase). A new case (blank or from a
// template) always starts with none.
let allAdmins = $state<Api<"AdminOut">[]>([]);
let isAdminsLoaded = $state(false);
let isLoadingAdmins = $state(false);
let collaboratorAdminIds = $state<number[]>([]);
let ownerAdminId = $state<number | null>(null);

const versionPoll = useCaseVersionPoll({
	caseId: () => (isEditMode ? editCaseId : null),
	isLoadingSource: () => isLoadingSource,
});

// Tracks unsaved edits so AdminTopBar can gate home/logout navigation behind
// a save-or-discard prompt. null baseline means "nothing loaded to compare
// against yet" (edit/template mode before loadCase resolves). Covers both the
// scalar case fields and the persona graph, so there's one dirty mechanism
// instead of a flag to remember to set on every field-level edit.
let baselineSnapshot = $state<string | null>(null);

// File objects serialize to "{}" under plain JSON.stringify (none of their
// properties are own-enumerable), which would make two different selected
// files compare equal — replace them with a value that actually changes.
function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof File) {
		return {
			name: value.name,
			size: value.size,
			lastModified: value.lastModified,
		};
	}
	return value;
}

function snapshotState(): string {
	return JSON.stringify(
		{
			caseName,
			initialBrief,
			commonInformation,
			simulationDurationMinutes,
			accessCode,
			collaboratorAdminIds,
			personas: graph.personas,
			referrals: graph.referrals,
			roots: graph.roots,
		},
		jsonReplacer,
	);
}

function markSaved(): void {
	baselineSnapshot = snapshotState();
}

// A brand-new case (no source to load) has nothing to wait on — the empty
// form itself is the baseline, captured once at setup.
if (!sourceCaseId) markSaved();

const isDirty = $derived(
	baselineSnapshot !== null && snapshotState() !== baselineSnapshot,
);

let showFieldErrors = $state(false);
function revealErrors() {
	showFieldErrors = true;
}

let isLoadingSource = $state(untrack(() => Boolean(sourceCaseId)));
let loadErrorMessage = $state("");
let submitError = $state("");
let submitSuccess = $state("");
let isSubmitting = $state(false);
let importWarnings = $state<string[]>([]);
let importError = $state("");
let fileInputEl = $state<HTMLInputElement | null>(null);

// Roster for the collaborator picker. Reuses the same admin-listing endpoint
// as admin/admins/+page.svelte — any authenticated admin can call it, not
// just SUPER admins. Fetched lazily (only when the picker popover is first
// opened, see below) rather than on form load, since most form loads never
// touch the collaborator picker at all.
async function ensureAdminsLoaded(): Promise<void> {
	if (isAdminsLoaded || isLoadingAdmins) return;
	isLoadingAdmins = true;
	try {
		allAdmins = await apiFetch<Api<"AdminOut">[]>("/api/admin/admins");
		isAdminsLoaded = true;
	} catch {
		// Leave isAdminsLoaded false — next open just retries.
	} finally {
		isLoadingAdmins = false;
	}
}

// Shared by the initial load and the conflict modal's "Reload" action.
async function loadCase(id: string): Promise<void> {
	const data = await apiFetch<Api<"CaseDetailResponse">>(`/api/cases/${id}`);
	const loadedCase = data.case;
	caseName = loadedCase.case_name ?? "";
	initialBrief = loadedCase.brief ?? "";
	commonInformation = loadedCase.common_information ?? "";
	simulationDurationMinutes = loadedCase.simulation_duration ?? null;
	accessCode = loadedCase.access_code ?? "";
	graph.load({
		personas: (loadedCase.personas ?? []).map((persona) =>
			normalizePersona(persona),
		),
		referrals: (loadedCase.referrals ?? []).map((referral) =>
			normalizeReferral(referral),
		),
		roots: loadedCase.roots ?? [],
	});
	if (isEditMode) {
		collaboratorAdminIds = loadedCase.collaborator_admin_ids ?? [];
		ownerAdminId = loadedCase.owner_admin_id ?? null;
		versionPoll.setLoadedVersion(loadedCase.version ?? null);
	}
	revealErrors();
	markSaved();
}

$effect(() => {
	if (!sourceCaseId) return;
	loadCase(sourceCaseId)
		.catch((err: unknown) => {
			loadErrorMessage =
				(err instanceof Error && err.message) ||
				(isEditMode
					? "Failed to load case for editing."
					: "Failed to load case template.");
		})
		.finally(() => {
			isLoadingSource = false;
		});
});

// Effective owner used to exclude from the collaborator picker: the loaded
// case's owner in edit mode, or the signed-in admin (matched by email
// against the roster, since the session store doesn't carry an admin id)
// when creating a new case.
const effectiveOwnerId = $derived(
	isEditMode
		? ownerAdminId
		: (allAdmins.find((admin) => admin.email === session.adminEmail)?.id ??
				null),
);
// SUPER admins already have full access to every case — no need to offer
// explicitly granting it.
const selectableAdmins = $derived(
	allAdmins.filter(
		(admin) => admin.role !== ADMIN_ROLE.SUPER && admin.id !== effectiveOwnerId,
	),
);

// "Reload" — discards in-progress edits and refetches everything, including
// the current version.
async function handleReloadFromConflict(): Promise<void> {
	versionPoll.showConflictModal = false;
	if (!editCaseId) return;
	isLoadingSource = true;
	try {
		await loadCase(editCaseId);
	} catch (err) {
		loadErrorMessage =
			(err instanceof Error && err.message) || "Failed to reload case.";
	} finally {
		isLoadingSource = false;
	}
}

const caseNameError = $derived(
	!caseName.trim() ? "Case name is required." : null,
);
const initialBriefError = $derived(
	!initialBrief.trim() ? "Initial brief is required." : null,
);
const accessCodeError = $derived(
	!accessCode.trim() ? "Access code is required." : null,
);
const simulationDurationError = $derived(
	typeof simulationDurationMinutes === "number" &&
		(simulationDurationMinutes > MAX_SIMULATION_DURATION ||
			simulationDurationMinutes < 1)
		? `Simulation duration must be between 1 and ${MAX_SIMULATION_DURATION} minutes (2 hours).`
		: null,
);

const graphValidation = $derived(graph.validate());
const hasValidationErrors = $derived(
	Boolean(caseNameError) ||
		Boolean(initialBriefError) ||
		Boolean(accessCodeError) ||
		Boolean(simulationDurationError) ||
		graphValidation.hasErrors,
);
const displayedError = $derived(submitError || loadErrorMessage);

// Builds a .html form from whatever's currently in this form
function handleExportTemplate(): void {
	const html = buildHTMLForm({
		caseName,
		accessCode,
		simulationDurationMinutes,
		initialBrief,
		commonInformation,
		personas: graph.personas,
		referrals: graph.referrals,
		roots: graph.roots,
	});
	downloadForm(html, caseName);
}

function handleImportClick(): void {
	fileInputEl?.click();
}

// Parses a filled-in export back into form state
async function handleImportFile(
	event: Event & { currentTarget: EventTarget & HTMLInputElement },
): Promise<void> {
	const file = event.currentTarget.files?.[0];
	event.currentTarget.value = "";
	if (!file) return;

	const hasExistingData =
		caseName.trim() ||
		initialBrief.trim() ||
		accessCode.trim() ||
		graph.personas.length > 0;
	if (
		hasExistingData &&
		!window.confirm(
			"Import will replace everything currently in this form. Continue?",
		)
	) {
		return;
	}

	importError = "";
	importWarnings = [];
	try {
		const text = await file.text();
		const { data, warnings } = parseHTMLForm(text);
		caseName = data.caseName;
		accessCode = data.accessCode;
		initialBrief = data.initialBrief;
		commonInformation = data.commonInformation;
		simulationDurationMinutes = data.simulationDurationMinutes;
		graph.applyImport({
			personas: data.personas,
			referrals: data.referrals,
			roots: data.roots,
		});
		importWarnings = warnings;
		revealErrors();
	} catch (err) {
		importError =
			err instanceof CaseImportError
				? err.message
				: "Failed to read that file. Make sure it’s an unmodified export from this app.";
	}
}

// Single source of truth for saving: used by the form's own Submit button
// and by AdminTopBar's "Save changes" action (via unsavedGuard), so both
// paths get the same validation gate and version-conflict handling.
async function performSave(): Promise<SaveResult> {
	revealErrors();
	if (hasValidationErrors) {
		const message = "Resolve the highlighted fields before saving.";
		submitError = message;
		return { ok: false, error: message };
	}
	loadErrorMessage = "";
	submitError = "";
	submitSuccess = "";
	isSubmitting = true;
	try {
		await submitCase({
			isEditMode,
			editCaseId,
			caseName,
			initialBrief,
			commonInformation,
			simulationDurationMinutes,
			accessCode,
			personas: graph.personas,
			referrals: graph.referrals,
			roots: graph.roots,
			collaboratorAdminIds,
			// Populated by loadCase before isLoadingSource clears in edit mode
			// (the submit button stays disabled until then), so this is always
			// a number by the time an edit-mode submit can actually run.
			expectedVersion: versionPoll.loadedVersion ?? undefined,
		});
		submitSuccess = isEditMode
			? "Case updated successfully."
			: "Case saved successfully.";
		if (isEditMode) versionPoll.bumpVersion();
		markSaved();
		return { ok: true };
	} catch (err) {
		if (err instanceof ApiError && err.code === "version_conflict") {
			versionPoll.showConflictModal = true;
			const message =
				"This case was updated by someone else. Resolve the conflict, then save again.";
			return { ok: false, error: message };
		}
		const message = (err instanceof Error && err.message) || "Upload failed.";
		submitError = message;
		return { ok: false, error: message };
	} finally {
		isSubmitting = false;
	}
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	await performSave();
}

onMount(() => {
	unsavedGuard.register(() => isDirty, performSave);
});

onDestroy(() => {
	unsavedGuard.unregister();
});
</script>

<div class="relative min-h-screen bg-parchment">
	<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>
	<div class="mx-auto max-w-4xl px-6 py-10">
		<div class="rounded-2xl border border-line bg-white p-8 shadow-soft">
			<form onsubmit={handleSubmit} class="flex flex-col gap-6">
				<div class="relative">
					<div class="text-center">
						<p class="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
							Case Builder
						</p>
						<h1 class="mt-1.5 font-display text-3xl font-semibold text-ink">
							{isEditMode ? 'Edit Case Study' : 'New Case Study'}
						</h1>
					</div>
					<div class="absolute right-0 top-0 flex gap-2">
						{#if canImport}
							<input
								bind:this={fileInputEl}
								type="file"
								accept=".html,.htm,text/html"
								class="hidden"
								onchange={handleImportFile}
							/>
							<button
								type="button"
								onclick={handleImportClick}
								class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand"
							>
								Import template
							</button>
						{/if}
						<button
							type="button"
							onclick={handleExportTemplate}
							class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand"
						>
							Export template
						</button>
					</div>
				</div>

				{#if isLoadingSource}
					<p class="text-center text-sm text-stone">
						{isEditMode ? 'Loading case...' : 'Loading case template...'}
					</p>
				{/if}

				{#if importError}
					<div class="rounded-xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
						<div class="flex items-start justify-between gap-3">
							<p>{importError}</p>
							<button
								type="button"
								onclick={() => (importError = '')}
								class="text-xs font-semibold text-brand"
								aria-label="Dismiss"
							>
								&times;
							</button>
						</div>
					</div>
				{/if}

				{#if importWarnings.length > 0}
					<div class="rounded-xl border border-line bg-cream/60 px-4 py-3 text-sm text-ink-soft">
						<div class="flex items-start justify-between gap-3">
							<p class="font-semibold text-ink">
								Imported with {importWarnings.length} issue{importWarnings.length === 1 ? '' : 's'} to review
							</p>
							<button
								type="button"
								onclick={() => (importWarnings = [])}
								class="text-xs font-semibold text-stone-soft"
								aria-label="Dismiss"
							>
								&times;
							</button>
						</div>
						<ul class="mt-2 flex flex-col gap-1">
							{#each importWarnings as warning (warning)}
								<li class="text-xs">{warning}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<details class="rounded-2xl border border-line bg-white" open>
					<summary class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink">
						Case Information
					</summary>
					<div class="flex flex-col gap-4 border-t border-line-soft px-5 py-5">
						<div class="flex flex-col gap-1.5">
							<label for="case-name" class="text-xs font-medium text-stone-soft">Case name</label>
							<input
								id="case-name"
								type="text"
								required
								placeholder="Enter case name"
								bind:value={caseName}
								oninput={revealErrors}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
							{#if showFieldErrors && caseNameError}
								<p class="text-xs font-medium text-brand">{caseNameError}</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="initial-brief" class="text-xs font-medium text-stone-soft">Initial brief</label>
							<textarea
								id="initial-brief"
								rows="3"
								required
								placeholder="Summarize the initial brief"
								bind:value={initialBrief}
								oninput={revealErrors}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							></textarea>
							{#if showFieldErrors && initialBriefError}
								<p class="text-xs font-medium text-brand">{initialBriefError}</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="common-information" class="text-xs font-medium text-stone-soft">Enter Case Background</label>
							<textarea
								id="common-information"
								rows="3"
								placeholder="Describe the common information"
								bind:value={commonInformation}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							></textarea>
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="simulation-duration" class="text-xs font-medium text-stone-soft">Simulation duration (Minutes)</label>
							<input
								id="simulation-duration"
								type="number"
								min="1"
								max={MAX_SIMULATION_DURATION}
								step="1"
								placeholder="Leave empty for unlimited"
								value={simulationDurationMinutes ?? ''}
								oninput={(event) => {
									revealErrors()
									simulationDurationMinutes = parseIntOrNull(event.currentTarget.value)
								}}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
							{#if simulationDurationError}
								<p class="text-xs font-medium text-brand">{simulationDurationError}</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<label for="access-code" class="text-xs font-medium text-stone-soft">Access code</label>
							<input
								id="access-code"
								type="text"
								required
								placeholder="Enter access code"
								bind:value={accessCode}
								oninput={revealErrors}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
							{#if showFieldErrors && accessCodeError}
								<p class="text-xs font-medium text-brand">{accessCodeError}</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<span class="text-xs font-medium text-stone-soft">Add collaborators</span>
							<p class="text-xs text-stone">
								Collaborators get full edit access to this case, same as the owner.
							</p>
							<Popover.Root onOpenChange={(open) => open && ensureAdminsLoaded()}>
								<Popover.Trigger
									class="flex w-fit items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition hover:border-brand hover:text-brand"
								>
									Add collaborators
									{#if collaboratorAdminIds.length > 0}
										<span class="rounded-full bg-brand-tint px-2 py-0.5 text-xs font-semibold text-brand">
											{collaboratorAdminIds.length} selected
										</span>
									{/if}
									<span aria-hidden="true">▾</span>
								</Popover.Trigger>
								<Popover.Portal>
									<Popover.Content
										class="z-50 w-64 rounded-lg border border-line bg-white p-3 shadow-soft"
										sideOffset={6}
									>
										{#if isLoadingAdmins}
											<p class="text-xs text-stone-soft">Loading admins…</p>
										{:else if selectableAdmins.length === 0}
											<p class="text-xs text-stone-soft">No other admins available to add.</p>
										{:else}
											<div class="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
												{#each selectableAdmins as admin (admin.id)}
													<label class="flex items-center gap-2 text-sm text-ink-soft">
														<input
															type="checkbox"
															checked={collaboratorAdminIds.includes(admin.id)}
															onchange={(event) => {
																const checked = event.currentTarget.checked
																collaboratorAdminIds = checked
																	? [...collaboratorAdminIds, admin.id]
																	: collaboratorAdminIds.filter((id) => id !== admin.id)
															}}
															class="h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
														/>
														<span>{admin.name || admin.email}</span>
													</label>
												{/each}
											</div>
										{/if}
									</Popover.Content>
								</Popover.Portal>
							</Popover.Root>
						</div>
					</div>
				</details>

				<CaseGraphEditor {graph} {showFieldErrors} {revealErrors} />

				{#if displayedError}
					<p class="text-sm font-medium text-brand">{displayedError}</p>
				{/if}
				{#if submitSuccess}
					<p class="text-sm font-medium text-success">{submitSuccess}</p>
				{/if}
				{#if showFieldErrors && hasValidationErrors}
					<p class="text-sm font-medium text-brand">
						Resolve the highlighted fields above before submitting.
					</p>
				{/if}

				<button
					type="submit"
					disabled={isLoadingSource || isSubmitting || hasValidationErrors}
					class="self-start rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{isSubmitting ? 'Submitting…' : 'Submit'}
				</button>
			</form>
		</div>
	</div>
</div>
<CaseConflictModal
	bind:open={versionPoll.showConflictModal}
	onReload={handleReloadFromConflict}
	onKeepEditing={() => versionPoll.handleKeepEditing()}
/>
