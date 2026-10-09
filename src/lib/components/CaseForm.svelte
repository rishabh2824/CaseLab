<script lang="ts">
import { getConvexClient, useQuery } from "convex-svelte";
import { onDestroy, onMount, untrack } from "svelte";
import { toast } from "svelte-sonner";
import { getViewerContext } from "#lib/adminViewer.js";
import { CaseDraft } from "#lib/case/caseDraft.svelte.js";
import { buildHTMLForm, downloadForm } from "#lib/case/exportCase.js";
import { CaseImportError, parseHTMLForm } from "#lib/case/importCase.js";
import { submitCase } from "#lib/case/submitCase.js";
import { getErrorMessage } from "#lib/errors.js";
import { type SaveResult, unsavedGuard } from "#lib/unsavedGuard.svelte.js";
import { beforeNavigate, goto } from "$app/navigation";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import CaseGraphEditor from "./CaseGraphEditor.svelte";
import CaseInfoFields from "./CaseInfoFields.svelte";
import DestructiveConfirmDialog from "./DestructiveConfirmDialog.svelte";

type Props = {
	mode: "create" | "edit";
	caseId?: string | null;
	templateId?: string | null;
};

let { mode, caseId = null, templateId = null }: Props = $props();

const isEditMode = $derived(mode === "edit");
const editCaseId = $derived(isEditMode ? caseId : null);
const sourceCaseId = $derived(editCaseId || templateId);
const canImport = $derived(!sourceCaseId);

const draft = new CaseDraft();

const adminsQuery = useQuery(api.admins.listAll, {});
const allAdmins = $derived(adminsQuery.data ?? []);
const viewerQuery = getViewerContext();
let ownerAdminId = $state<string | null>(null);

// svelte-ignore state_referenced_locally
if (!sourceCaseId) draft.markSaved();

let isLoadingSource = $state(untrack(() => Boolean(sourceCaseId)));
let loadErrorMessage = $state("");
let submitError = $state("");
let submitSuccess = $state("");
let suppressInlineSuccess = $state(false);
let isSubmitting = $state(false);
let importWarnings = $state<string[]>([]);
let pendingImportFile = $state<File | null>(null);
let fileInputEl = $state<HTMLInputElement | null>(null);
let lastSavedCaseId: string | null = null;

// Loads a case (or template) from the server into the form and marks it clean.
async function loadCase(id: string): Promise<void> {
	const loadedCase = await getConvexClient().query(api.cases.getForEdit, {
		caseId: id as Id<"cases">,
	});
	if (sourceCaseId !== id) return;
	draft.load(loadedCase, { isEditMode });
	if (isEditMode) ownerAdminId = loadedCase.ownerAdminId ?? null;
}

$effect(() => {
	if (!sourceCaseId) return;
	const id = sourceCaseId;
	isLoadingSource = true;
	loadErrorMessage = "";
	loadCase(id)
		.catch((err: unknown) => {
			if (sourceCaseId !== id) return;
			loadErrorMessage = getErrorMessage(
				err,
				isEditMode
					? "Failed to load case for editing."
					: "Failed to load case template.",
			);
		})
		.finally(() => {
			if (sourceCaseId !== id) return;
			isLoadingSource = false;
		});
});

const effectiveOwnerId = $derived(
	isEditMode ? ownerAdminId : (viewerQuery.data?._id ?? null),
);

const displayedError = $derived(submitError || loadErrorMessage);

// Exports the current form as a downloadable HTML template.
function handleExportTemplate(): void {
	downloadForm(buildHTMLForm(draft.exportInput()));
}

// Opens the file picker for importing an exported case.
function handleImportClick(): void {
	fileInputEl?.click();
}

// Handles a chosen import file, asking for confirmation first if the form already has content.
function handleImportFile(
	event: Event & { currentTarget: EventTarget & HTMLInputElement },
): void {
	const file = event.currentTarget.files?.[0];
	event.currentTarget.value = "";
	if (!file) return;

	if (draft.hasContent) {
		pendingImportFile = file;
		return;
	}
	void performImport(file);
}

// Imports the file the user confirmed replacing the form with.
async function confirmImport(): Promise<void> {
	const file = pendingImportFile;
	pendingImportFile = null;
	if (file) await performImport(file);
}

// Parses an exported HTML form into the form fields, or shows a toast if the file is unusable.
async function performImport(file: File): Promise<void> {
	importWarnings = [];
	try {
		const text = await file.text();
		const { data, warnings } = parseHTMLForm(text);
		draft.applyImport(data);
		importWarnings = warnings;
	} catch (err) {
		toast(
			err instanceof CaseImportError
				? err.message
				: "Failed to read that file. Make sure it’s an unmodified export from this app.",
		);
	}
}

let inFlightSave: Promise<SaveResult> | null = null;

// Saves the form, reusing the save already in flight if there is one.
function performSave(): Promise<SaveResult> {
	if (inFlightSave) return inFlightSave;
	const attempt = runSave();
	inFlightSave = attempt.finally(() => {
		inFlightSave = null;
	});
	return inFlightSave;
}

// Validates and submits the case, then updates the success, error and baseline state.
async function runSave(): Promise<SaveResult> {
	draft.revealErrors();
	if (draft.hasErrors) {
		const message = "Resolve the highlighted fields before saving.";
		submitError = message;
		return { ok: false, error: message };
	}
	loadErrorMessage = "";
	submitError = "";
	submitSuccess = "";
	suppressInlineSuccess = false;
	isSubmitting = true;
	try {
		const result = await submitCase(draft.submitInput(editCaseId));
		lastSavedCaseId = result.caseId;
		submitSuccess = isEditMode
			? "Case updated successfully."
			: "Case saved successfully.";
		if (isEditMode && editCaseId) {
			try {
				await loadCase(editCaseId);
			} catch {
				draft.markSaved();
			}
		} else {
			draft.markSaved();
		}
		return { ok: true };
	} catch (err) {
		const message = getErrorMessage(err, "Failed to save the case.");
		submitError = message;
		return { ok: false, error: message };
	} finally {
		isSubmitting = false;
	}
}

// Handles the form submit, moving to the new case's edit page after a first save.
async function handleSubmit(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	const result = await performSave();
	if (result.ok && !isEditMode && lastSavedCaseId) {
		suppressInlineSuccess = true;
		toast(submitSuccess);
		await goto(`/admin/cases/${lastSavedCaseId}/edit`);
	}
}

beforeNavigate((navigation) => {
	if (!unsavedGuard.isDirty) return;
	const targetUrl = navigation.to?.url;
	if (!targetUrl) return;
	navigation.cancel();
	const resume =
		navigation.type === "popstate" && navigation.delta !== undefined
			? () => history.go(navigation.delta)
			: () => goto(targetUrl);
	unsavedGuard.requestNavigation(resume);
});

onMount(() => {
	unsavedGuard.register(() => draft.isDirty, performSave);
	function handleBeforeUnload(event: BeforeUnloadEvent): void {
		if (!unsavedGuard.isDirty) return;
		event.preventDefault();
		event.returnValue = "";
	}
	window.addEventListener("beforeunload", handleBeforeUnload);
	return () => window.removeEventListener("beforeunload", handleBeforeUnload);
});

onDestroy(() => {
	unsavedGuard.unregister();
});
</script>

<div class="relative min-h-screen bg-parchment">
	<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>
	<div class="mx-auto max-w-4xl px-6 py-10">
		<div class="rounded-2xl border border-line bg-white p-8 shadow-soft">
			<form novalidate onsubmit={handleSubmit} class="flex flex-col gap-6">
				<fieldset disabled={isSubmitting || isLoadingSource} class="contents">
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
								class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60"
							>
								Import template
							</button>
						{/if}
						<button
							type="button"
							onclick={handleExportTemplate}
							class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60"
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

				<CaseInfoFields
					{draft}
					{allAdmins}
					adminsLoading={adminsQuery.isLoading}
					{effectiveOwnerId}
				/>

				<CaseGraphEditor
					graph={draft.graph}
					showFieldErrors={draft.showErrors}
					revealErrors={() => draft.revealErrors()}
				/>

				{#if displayedError}
					<p class="text-sm font-medium text-brand">{displayedError}</p>
				{/if}
				{#if submitSuccess && !suppressInlineSuccess}
					<p class="text-sm font-medium text-success">{submitSuccess}</p>
				{/if}
				{#if draft.showErrors && draft.hasErrors}
					<p class="text-sm font-medium text-brand">
						Resolve the highlighted fields above before submitting.
					</p>
				{/if}

				<button
					type="submit"
					class="self-start rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{isSubmitting ? 'Submitting…' : 'Submit'}
				</button>
				</fieldset>
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
/>
