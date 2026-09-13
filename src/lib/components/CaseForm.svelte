<script lang="ts">
import { getConvexClient, useQuery } from "convex-svelte";
import { onDestroy, onMount, untrack } from "svelte";
import { toast } from "svelte-sonner";
import { beforeNavigate, goto } from "$app/navigation";
import {
	getCaseInfoErrors,
	hasFieldErrors,
	parseCaseStructure,
} from "$lib/case/draft.js";
import { buildHTMLForm, downloadForm } from "$lib/case/exportCase.js";
import { CaseGraph } from "$lib/case/graph.svelte.js";
import { CaseImportError, parseHTMLForm } from "$lib/case/importCase.js";
import { submitCase } from "$lib/case/submitCase.js";
import { getErrorMessage } from "$lib/errors.js";
import { type SaveResult, unsavedGuard } from "$lib/unsavedGuard.svelte.js";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { RUN_LIFETIME_MINUTES } from "../../../convex/schema.js";
import CaseGraphEditor from "./CaseGraphEditor.svelte";
import CaseInfoFields from "./CaseInfoFields.svelte";
import DestructiveConfirmDialog from "./DestructiveConfirmDialog.svelte";

const MAX_SIMULATION_DURATION = RUN_LIFETIME_MINUTES;

// mode is explicit (set by the route: /admin/cases/new vs.
// /admin/cases/[id]/edit), not inferred from which of caseId/templateId
// happens to be non-null. caseId is the resource identity in edit mode
// (sourced from page.params.id, a real path segment); templateId is only
// ever a "prefill from" hint on the create route (page.url.searchParams,
// since it doesn't identify the case being created). Both are only ever
// passed as the `caseId` argument to api/cases:getForEdit, never parsed as
// a number.
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
// Always-subscribed, not fetched lazily on popover open: Convex's reactivity makes a live
// subscription to a ~10-row table cheap enough that the bookkeeping to defer it isn't worth
// keeping.
const adminsQuery = useQuery(api.api.admins.listAll, {});
const allAdmins = $derived(adminsQuery.data ?? []);
// admin/+layout.svelte already subscribes to this same query+args -- Convex dedupes the
// subscription, so this isn't a second network round trip, just a second read of a value
// already being kept live.
const viewerQuery = useQuery(api.api.admins.viewer, {});
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
		{
			personas: graph.personas,
			referrals: graph.referrals,
			roots: graph.roots,
		},
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
// svelte-ignore state_referenced_locally -- intentional: sourceCaseId is only
// checked once here, not tracked reactively.
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
		collaboratorAdminIds.some(
			(id, i) => id !== baseline.collaboratorAdminIds[i],
		)
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
// The id submitCase's most recent successful call created/updated -- not reactive state,
// just read by handleSubmit right after a create so it can leave this route once the case
// exists (see handleSubmit below). Not threaded through performSave's own SaveResult, which
// AdminTopBar's unsaved-changes save path (the other caller of performSave) has no use for.
let lastSavedCaseId: string | null = null;

// Loads a case's fields into the form, either as the resource being edited (edit mode) or
// as a from-scratch starting point (template mode, via TemplatePicker) -- the same query
// serves both. They differ only in whether collaborators come along, since a template load
// always starts a brand-new case with none.
async function loadCase(id: string): Promise<void> {
	const loadedCase = await getConvexClient().query(api.api.cases.getForEdit, {
		caseId: id as Id<"cases">,
	});
	// A newer load may have started since this one was kicked off -- switching `?template=`
	// (or, in edit mode, navigating straight from one case's edit route to another's) while
	// this form stays mounted re-triggers the effect below without unmounting/remounting this
	// component, so two loadCase calls can be in flight together, and the one that resolves
	// LAST would otherwise win regardless of which one is actually current. Bail out here,
	// before touching any form state, once sourceCaseId has moved on from the id this call
	// was asked to load.
	if (sourceCaseId !== id) return;
	caseName = loadedCase.name ?? "";
	initialBrief = loadedCase.brief ?? "";
	commonInformation = loadedCase.commonInformation ?? "";
	simulationDurationMinutes = loadedCase.duration ?? null;
	// Edit mode keeps the case's own code; a template load starts blank -- the source case's
	// code is already claimed by that case, so carrying it over here just guarantees the new
	// case's first save fails on it (createCase rejects a duplicate access code).
	accessCode = isEditMode ? (loadedCase.accessCode ?? "") : "";
	graph.load(parseCaseStructure(loadedCase.structure));
	if (isEditMode) {
		collaboratorAdminIds = loadedCase.collaboratorAdminIds ?? [];
		ownerAdminId = loadedCase.ownerAdminId ?? null;
	}
	revealErrors();
	markSaved();
}

$effect(() => {
	if (!sourceCaseId) return;
	// Captured once per effect run: sourceCaseId itself may move on (see loadCase's own
	// guard above) before this particular load settles, and the checks below need to compare
	// against the id THIS run was loading for, not whatever it's since become.
	const id = sourceCaseId;
	// Reset both eagerly, not just on completion -- otherwise switching sources while a
	// previous load's error or "done loading" state is still showing leaves that stale state
	// on screen for however long the new load takes, instead of immediately reflecting that a
	// fresh load has started.
	isLoadingSource = true;
	loadErrorMessage = "";
	loadCase(id)
		.catch((err: unknown) => {
			if (sourceCaseId !== id) return; // superseded -- let the newer run report its own error
			loadErrorMessage = getErrorMessage(
				err,
				isEditMode
					? "Failed to load case for editing."
					: "Failed to load case template.",
			);
		})
		.finally(() => {
			if (sourceCaseId !== id) return; // superseded -- the newer run owns isLoadingSource now
			isLoadingSource = false;
		});
});

// Effective owner used to exclude from the collaborator picker: the loaded
// case's owner in edit mode, or the signed-in admin when creating a new case
// (api/admins:viewer resolves that identity server-side directly).
const effectiveOwnerId = $derived(
	isEditMode ? ownerAdminId : (viewerQuery.data?._id ?? null),
);

// Computed the same way graph.validation is (a pure function of the scalar fields, not
// pushed up from CaseInfoFields via a bind:hasErrors + $effect) -- CaseInfoFields.svelte
// calls this same getCaseInfoErrors for its own per-field messages, so the two can't drift.
const caseInfoErrors = $derived(
	getCaseInfoErrors({
		caseName,
		initialBrief,
		accessCode,
		simulationDurationMinutes,
		maxSimulationDuration: MAX_SIMULATION_DURATION,
	}),
);
const caseInfoHasErrors = $derived(hasFieldErrors(caseInfoErrors));

const graphValidation = $derived(graph.validation);
const hasValidationErrors = $derived(
	caseInfoHasErrors || graphValidation.hasErrors,
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
	downloadForm(html);
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
		graph.load({
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
//
// Deduped against itself: without inFlightSave, the Submit button (disabled while isSubmitting,
// so a second click can't reach this) and AdminTopBar's own "Save changes" prompt (its own,
// separate gesture, not blocked by the Submit button's disabled state) could both call this at
// once -- a second create racing the first would fail outright once the first claims the access
// code, and a second update would just be redundant work. A second concurrent call reuses the
// first attempt's promise instead of starting its own.
let inFlightSave: Promise<SaveResult> | null = null;

function performSave(): Promise<SaveResult> {
	if (inFlightSave) return inFlightSave;
	const attempt = runSave();
	inFlightSave = attempt.finally(() => {
		inFlightSave = null;
	});
	return inFlightSave;
}

async function runSave(): Promise<SaveResult> {
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
		const result = await submitCase({
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
		lastSavedCaseId = result.caseId;
		submitSuccess = isEditMode
			? "Case updated successfully."
			: "Case saved successfully.";
		if (isEditMode && editCaseId) {
			// Reloads the just-saved case from the server rather than only calling markSaved()
			// against the form's own in-memory state: submitCase already uploaded every picked
			// File and swapped it for a FileRef in the payload it sent, but the form's own
			// persona/file state still holds the original File objects -- left alone, the next
			// save would upload them all over again (uploadAll in submitCase.ts) and orphan the
			// files row this save just created. The server also trims name/brief/persona
			// name+role and drops any fileless attachment slot (see buildStructure's own
			// comment) -- reloading is what keeps the form showing exactly what was persisted
			// instead of silently drifting from it. Create mode needs no equivalent: handleSubmit
			// below leaves this route for the edit route the moment a create succeeds, which
			// mounts a brand-new CaseForm that loads the just-created case fresh on its own.
			try {
				await loadCase(editCaseId);
			} catch {
				// The save itself already succeeded -- a reload hiccup (e.g. a dropped
				// connection) shouldn't turn that into a visible failure. Fall back to marking
				// the form's current (still-correct-enough) in-memory state as the new baseline.
				markSaved();
			}
		} else {
			markSaved();
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

async function handleSubmit(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	const result = await performSave();
	// A save from the Submit button, not from AdminTopBar's unsaved-changes prompt (that path
	// already navigates wherever the admin asked to go next). Leaving the create route the
	// moment the case exists is what stops a second Submit click from re-running `create`
	// against a case that already saved -- which fails outright once its access code is
	// already taken (see resolveCasePayload's own conflict check).
	if (result.ok && !isEditMode && lastSavedCaseId) {
		toast(submitSuccess);
		await goto(`/admin/cases/${lastSavedCaseId}/edit`);
	}
}

// Browser back/forward, clicking a link elsewhere, or any other in-app navigation away from
// this form while it has unsaved edits -- not just the two buttons AdminTopBar's own
// requestNavigation calls cover. Cancels the navigation and re-issues it as the same
// save-or-discard prompt those buttons show, once the admin picks one.
//
// Gated on unsavedGuard.isDirty, not the form's own local `isDirty` -- discard() unregisters
// this form from the guard (dirtySource -> null, so unsavedGuard.isDirty flips to false) but
// doesn't touch the form's own baseline, so local `isDirty` would still read true and this
// guard would cancel the very goto() discard() just issued -- which re-enters
// requestNavigation, which (now genuinely not dirty) fires the action again, cancelling it
// again, forever. unsavedGuard.isDirty tracks the same dirtySource() while registered, so this
// is a no-op change for every other path (Cancel, Save) and only differs once discard has
// unregistered.
beforeNavigate((navigation) => {
	if (!unsavedGuard.isDirty) return;
	const targetUrl = navigation.to?.url;
	if (!targetUrl) return;
	navigation.cancel();
	unsavedGuard.requestNavigation(() => goto(targetUrl));
});

onMount(() => {
	unsavedGuard.register(() => isDirty, performSave);
	// Closing the tab, refreshing, or navigating to a URL outside this app entirely --
	// beforeNavigate above only ever sees in-app navigation. The browser's own native "leave
	// site?" prompt is the only hook available for this (no custom message; every modern
	// browser shows its own fixed text regardless of what's set here), so there's no route
	// through the app's own unsaved-changes modal for this specific case. Same
	// unsavedGuard.isDirty gate as beforeNavigate above, for the same reason.
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
			<form onsubmit={handleSubmit} class="flex flex-col gap-6">
				<!-- disabled cascades natively to every input/button/select this fieldset
				     contains, including inside CaseInfoFields/CaseGraphEditor -- covers import
				     (which would otherwise silently replace the form's content out from under a
				     save already in flight) and the collaborator popover, not just typing.
				     `class="contents"` keeps it out of the box layout entirely (the form's own
				     flex/gap applies directly to these children), so it changes nothing
				     visually. Gated on isSubmitting (a save is in flight) or isLoadingSource (the
				     source case hasn't loaded yet -- typing now would be overwritten the moment
				     it does, or by the reload after a save in edit mode). -->
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
					bind:caseName
					bind:initialBrief
					bind:commonInformation
					bind:simulationDurationMinutes
					bind:accessCode
					bind:collaboratorAdminIds
					maxSimulationDuration={MAX_SIMULATION_DURATION}
					{allAdmins}
					adminsLoading={adminsQuery.isLoading}
					{effectiveOwnerId}
					{showFieldErrors}
					{revealErrors}
				/>

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
