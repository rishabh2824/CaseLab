<script lang="ts">
import { Popover } from "bits-ui";
import { getConvexClient, useQuery } from "convex-svelte";
import { makeFunctionReference } from "convex/server";
import { onDestroy, onMount, untrack } from "svelte";
import { toast } from "svelte-sonner";
import {
	normalizePersona,
	normalizeReferral,
	parseIntOrNull,
} from "$lib/case/draft.js";
import { buildHTMLForm, downloadForm } from "$lib/case/exportCase.js";
import { CaseGraph } from "$lib/case/graph.svelte.js";
import { CaseImportError, parseHTMLForm } from "$lib/case/importCase.js";
import { submitCase } from "$lib/case/submitCase.js";
import { session } from "$lib/session.svelte.js";
import { type SaveResult, unsavedGuard } from "$lib/unsavedGuard.svelte.js";
import CaseGraphEditor from "./CaseGraphEditor.svelte";
import DestructiveConfirmDialog from "./DestructiveConfirmDialog.svelte";

// String-based references (not generated `api` imports): the convex/ project lives at
// the repo root, outside this Vite project's root -- see AdminAuth.svelte for why.
const listAllAdminsRef = makeFunctionReference<"query">("api/admins:listAll");
// Used both to load an existing case for editing and to load one as a create-from-template
// source -- see its comment in newBackend/convex/api/cases.ts.
const getForEditRef = makeFunctionReference<"query">("api/cases:getForEdit");

const MAX_SIMULATION_DURATION = 120;
// Mirrors newBackend/convex/services/cases.ts's ACCESS_CODE_FORMAT.
const ACCESS_CODE_FORMAT = /^[a-z]+$/;

type AdminRole = "super" | "admin";
type AdminRow = { _id: string; email: string; name?: string; role: AdminRole };

// mode is explicit (set by the route: /admin/cases/new vs.
// /admin/cases/[id]/edit), not inferred from which of caseId/templateId
// happens to be non-null. caseId is the resource identity in edit mode
// (sourced from page.params.id, a real path segment); templateId is only
// ever a "prefill from" hint on the create route (page.url.searchParams,
// since it doesn't identify the case being created). Both are only ever
// interpolated into `/api/cases/${sourceCaseId}`, never parsed to a number.
type Props = {
	mode: "create" | "edit";
	caseId?: string | null;
	templateId?: string | null;
};

let { mode, caseId = null, templateId = null }: Props = $props();

const isEditMode = $derived(mode === "edit");
const editCaseId = $derived(isEditMode ? caseId : null);
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
//
// Always-subscribed (not fetched lazily on popover open, as this used to be against the
// old backend's REST endpoint): Convex's reactivity makes a live subscription to a ~10-row
// table cheap enough that the bookkeeping to defer it isn't worth keeping.
const adminsQuery = useQuery(listAllAdminsRef, {});
const allAdmins = $derived((adminsQuery.data ?? []) as AdminRow[]);
let collaboratorAdminIds = $state<string[]>([]);
let ownerAdminId = $state<string | null>(null);

// Tracks unsaved edits so AdminTopBar can gate home/logout navigation behind
// a save-or-discard prompt. null baseline means "nothing loaded to compare
// against yet" (edit/template mode before loadCase resolves).
//
// Split into a cheap scalar comparison and a separate graph comparison
// (rather than one JSON.stringify of the whole case) so that Svelte's
// fine-grained $derived dependency tracking actually pays off: typing in
// caseName/brief/access-code only re-evaluates scalarsDirty's plain equality
// checks — it never touches graphDirty's derived (and so never re-serializes
// every persona) since graph.personas/referrals/roots didn't change. Editing
// inside the persona graph still has to serialize the graph to detect a
// change, but no longer drags the scalar fields/collaborator list along.
let baselineScalars = $state<{
	caseName: string;
	initialBrief: string;
	commonInformation: string;
	simulationDurationMinutes: number | null;
	accessCode: string;
	collaboratorAdminIds: string[];
} | null>(null);
let baselineGraphSnapshot = $state<string | null>(null);

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

function snapshotGraph(): string {
	return JSON.stringify(
		{ personas: graph.personas, referrals: graph.referrals, roots: graph.roots },
		jsonReplacer,
	);
}

function markSaved(): void {
	baselineScalars = {
		caseName,
		initialBrief,
		commonInformation,
		simulationDurationMinutes,
		accessCode,
		collaboratorAdminIds: [...collaboratorAdminIds],
	};
	baselineGraphSnapshot = snapshotGraph();
}

// A brand-new case (no source to load) has nothing to wait on — the empty
// form itself is the baseline, captured once at setup.
if (!sourceCaseId) markSaved();

const scalarsDirty = $derived.by(() => {
	const baseline = baselineScalars;
	if (baseline === null) return false;
	return (
		caseName !== baseline.caseName ||
		initialBrief !== baseline.initialBrief ||
		commonInformation !== baseline.commonInformation ||
		simulationDurationMinutes !== baseline.simulationDurationMinutes ||
		accessCode !== baseline.accessCode ||
		collaboratorAdminIds.length !== baseline.collaboratorAdminIds.length ||
		collaboratorAdminIds.some((id, i) => id !== baseline.collaboratorAdminIds[i])
	);
});
const graphDirty = $derived(
	baselineGraphSnapshot !== null && snapshotGraph() !== baselineGraphSnapshot,
);
const isDirty = $derived(scalarsDirty || graphDirty);

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
let pendingImportFile = $state<File | null>(null);
let fileInputEl = $state<HTMLInputElement | null>(null);

// Loads a case's fields into the form, either as the resource being edited (edit mode) or
// as a from-scratch starting point (template mode, via TemplatePicker) -- the same query
// serves both. They differ only in whether collaborators come along, since a template load
// always starts a brand-new case with none.
async function loadCase(id: string): Promise<void> {
	const loadedCase = await getConvexClient().query(getForEditRef, { caseId: id });
	const structure = (loadedCase.structure ?? {}) as {
		personas?: unknown[];
		referrals?: unknown[];
		roots?: string[];
	};
	caseName = loadedCase.name ?? "";
	initialBrief = loadedCase.brief ?? "";
	commonInformation = loadedCase.commonInformation ?? "";
	simulationDurationMinutes = loadedCase.duration ?? null;
	accessCode = loadedCase.accessCode ?? "";
	graph.load({
		personas: (structure.personas ?? []).map((persona) =>
			normalizePersona(persona as Parameters<typeof normalizePersona>[0]),
		),
		referrals: (structure.referrals ?? []).map((referral) =>
			normalizeReferral(referral as Parameters<typeof normalizeReferral>[0]),
		),
		roots: structure.roots ?? [],
	});
	if (isEditMode) {
		collaboratorAdminIds = (loadedCase.collaboratorAdminIds ?? []) as string[];
		ownerAdminId = (loadedCase.ownerAdminId ?? null) as string | null;
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
		: (allAdmins.find((admin) => admin.email === session.adminEmail)?._id ??
				null),
);
// SUPER admins already have full access to every case — no need to offer
// explicitly granting it.
const selectableAdmins = $derived(
	allAdmins.filter(
		(admin) => admin.role !== "super" && admin._id !== effectiveOwnerId,
	),
);

const caseNameError = $derived(
	!caseName.trim() ? "Case name is required." : null,
);
const initialBriefError = $derived(
	!initialBrief.trim() ? "Initial brief is required." : null,
);
const accessCodeError = $derived.by(() => {
	const trimmed = accessCode.trim();
	if (!trimmed) return "Access code is required.";
	// Mirrors both Convex's createCase and updateCase mutations -- every access code in the
	// migrated data is already pure lowercase, so there's no legacy case to carve an
	// exception out for.
	if (!ACCESS_CODE_FORMAT.test(trimmed)) {
		return "Access code must contain only lowercase letters.";
	}
	return null;
});
const simulationDurationError = $derived(
	typeof simulationDurationMinutes === "number" &&
		(simulationDurationMinutes > MAX_SIMULATION_DURATION ||
			simulationDurationMinutes < 1)
		? `Simulation duration must be between 1 and ${MAX_SIMULATION_DURATION} minutes (2 hours).`
		: null,
);

const graphValidation = $derived(graph.validation);
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

// Picks up a file from the input: if the form already has content, routes
// through the confirm dialog first (destructive — import replaces it all);
// otherwise imports immediately.
function handleImportFile(
	event: Event & { currentTarget: EventTarget & HTMLInputElement },
): void {
	const file = event.currentTarget.files?.[0];
	event.currentTarget.value = "";
	if (!file) return;

	const hasExistingData =
		caseName.trim() ||
		initialBrief.trim() ||
		accessCode.trim() ||
		graph.personas.length > 0;
	if (hasExistingData) {
		pendingImportFile = file;
		return;
	}
	void performImport(file);
}

function cancelImport(): void {
	pendingImportFile = null;
}

async function confirmImport(): Promise<void> {
	const file = pendingImportFile;
	pendingImportFile = null;
	if (file) await performImport(file);
}

// Parses a filled-in export back into form state
async function performImport(file: File): Promise<void> {
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
		toast(
			err instanceof CaseImportError
				? err.message
				: "Failed to read that file. Make sure it’s an unmodified export from this app.",
		);
	}
}

// Single source of truth for saving: used by the form's own Submit button
// and by AdminTopBar's "Save changes" action (via unsavedGuard), so both
// paths get the same validation gate and error handling.
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
		});
		submitSuccess = isEditMode
			? "Case updated successfully."
			: "Case saved successfully.";
		markSaved();
		return { ok: true };
	} catch (err) {
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
							<Popover.Root>
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
										{#if adminsQuery.isLoading}
											<p class="text-xs text-stone-soft">Loading admins…</p>
										{:else if selectableAdmins.length === 0}
											<p class="text-xs text-stone-soft">No other admins available to add.</p>
										{:else}
											<div class="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
												{#each selectableAdmins as admin (admin._id)}
													<label class="flex items-center gap-2 text-sm text-ink-soft">
														<input
															type="checkbox"
															checked={collaboratorAdminIds.includes(admin._id)}
															onchange={(event) => {
																const checked = event.currentTarget.checked
																collaboratorAdminIds = checked
																	? [...collaboratorAdminIds, admin._id]
																	: collaboratorAdminIds.filter((id) => id !== admin._id)
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
<DestructiveConfirmDialog
	bind:open={() => pendingImportFile !== null, (isOpen) => { if (!isOpen) pendingImportFile = null }}
	title="Replace everything in this form?"
	description="Import will replace everything currently in this form. This cannot be undone."
	confirmLabel="Import"
	pendingLabel="Importing…"
	onConfirm={confirmImport}
	onCancel={cancelImport}
/>
