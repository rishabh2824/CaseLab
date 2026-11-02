<script lang="ts">
import { useQuery } from "convex-svelte";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import { api } from "#convex/api.js";
import { getViewerContext } from "#lib/adminViewer.js";
import { CaseFormStore } from "#lib/case/caseFormStore.svelte.js";
import { type CaseTab, personaOf, tabOf } from "#lib/case/fieldPath.js";
import { focusField } from "#lib/case/focusField.js";
import { LeaveGuard } from "#lib/case/leaveGuard.svelte.js";
import type { CaseSource } from "#lib/types.js";
import type { CaseIssue } from "#shared/rules.js";
import { goto } from "$app/navigation";
import ConfirmDialog from "../ui/ConfirmDialog.svelte";
import CaseGraphEditor from "./CaseGraphEditor.svelte";
import CaseImportExport from "./CaseImportExport.svelte";
import CaseInfoFields from "./CaseInfoFields.svelte";
import CaseTabs from "./CaseTabs.svelte";
import SaveBar from "./SaveBar.svelte";

let { source }: { source: CaseSource } = $props();

const isEditMode = $derived(source.kind === "edit");
const editCaseId = $derived(source.kind === "edit" ? source.id : null);

const form = new CaseFormStore(untrack(() => source.kind !== "new"));
const draft = form.draft;
const leaveGuard = new LeaveGuard(
	() => draft.isDirty,
	() => form.save(editCaseId),
);

const adminsQuery = useQuery(api.admins.listAll, {});
const allAdmins = $derived(adminsQuery.data ?? []);
const viewerQuery = getViewerContext();

let selectedPersonaId = $state<string | null>(null);
let issuesOpen = $state(false);
// A new case starts at the beginning. An existing one opens on its personas, which is what admins usually come back to edit.
// svelte-ignore state_referenced_locally
let activeTab = $state<CaseTab>(source.kind === "edit" ? "personas" : "info");

$effect(() => {
	if (source.kind !== "new") void form.load(source.id, source.kind === "edit");
});

// A case shared with the viewer for reading only: every field is locked and there is nothing to save.
const readOnly = $derived(isEditMode && !draft.canEdit);

const effectiveOwnerId = $derived(
	isEditMode ? form.ownerAdminId : (viewerQuery.data?._id ?? null),
);

// While true every field is locked. The persona outline stays clickable so a view-only case can still be browsed.
const locked = $derived(form.isSubmitting || form.isLoading || readOnly);

// The problems on show, which stay hidden until the first save attempt so a new form doesn't open in red.
const visibleIssues = $derived(draft.showErrors ? draft.issues : []);
// A new case has nothing saved yet, so only an existing one can claim to be saved.
const saveStatus = $derived.by(() => {
	if (form.isLoading) return "";
	if (draft.isDirty) return "Unsaved changes";
	return isEditMode ? "All changes saved" : "";
});

// Closes the problem list and takes the admin to the field to fix.
function goToIssue(issue: CaseIssue): void {
	issuesOpen = false;
	activeTab = tabOf(issue.path);
	selectedPersonaId = personaOf(issue.path) ?? selectedPersonaId;
	void focusField(issue.path);
}

// Handles the form submit: lists what to fix, reports a failure, or moves to the new case's edit page after a first save.
async function handleSubmit(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	const result = await form.save(editCaseId);
	if (!result.ok) {
		if (draft.issues.length > 0) issuesOpen = true;
		else toast(result.error);
		return;
	}
	if (!isEditMode) await goto(`/admin/cases/${result.caseId}`);
}
</script>

	<div class="mx-auto max-w-4xl px-6 py-10">
		<div class="rounded-2xl border border-line bg-white p-8 shadow-soft">
			<form novalidate onsubmit={handleSubmit} class="flex flex-col gap-6">
				<fieldset disabled={locked} class="contents">
				<div class="relative">
					<div class="text-center">
						<p class="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
							Case Builder
						</p>
						<h1 class="mt-1.5 font-display text-3xl font-semibold text-ink">
							{isEditMode ? 'Edit Case Study' : 'New Case Study'}
						</h1>
					</div>
					<CaseImportExport {draft} canImport={source.kind === "new"} />
				</div>

				{#if readOnly}
					<p class="rounded-xl border border-line bg-cream px-4 py-3 text-sm text-stone">
						View only: you can read this case and copy it as a template, but not save changes.
					</p>
				{/if}

				{#if form.isLoading}
					<p class="text-center text-sm text-stone">
						{isEditMode ? 'Loading case...' : 'Loading case template...'}
					</p>
				{/if}

				</fieldset>

				<!-- Outside the fieldsets, so a view-only case can still be browsed. -->
				<CaseTabs
					bind:active={activeTab}
					hasIssues={(tab) => visibleIssues.some((issue) => tabOf(issue.path) === tab)}
				>
					{#snippet info()}
						<fieldset disabled={locked} class="contents">
							<CaseInfoFields
								{draft}
								{allAdmins}
								adminsLoading={adminsQuery.isLoading}
								{effectiveOwnerId}
							/>
						</fieldset>
					{/snippet}
					{#snippet personas()}
						<CaseGraphEditor
							graph={draft.graph}
							issues={visibleIssues}
							errorFor={(path) => draft.errorFor(path)}
							disabled={locked}
							bind:selectedId={selectedPersonaId}
						/>
					{/snippet}
				</CaseTabs>

				<fieldset disabled={locked} class="contents">

				{#if form.loadError}
					<p class="text-sm font-medium text-brand">{form.loadError}</p>
				{/if}

				{#if !readOnly}
					<SaveBar
						issues={visibleIssues}
						issuesLabel={draft.issuesLabel}
						status={saveStatus}
						saving={form.isSubmitting}
						bind:open={issuesOpen}
						onGoToIssue={goToIssue}
					/>
				{/if}
				</fieldset>
			</form>
		</div>
	</div>

<ConfirmDialog
	open={leaveGuard.pending !== null}
	onClose={() => leaveGuard.stay()}
	title="You have unsaved changes"
	description="This case has edits that haven't been saved yet. Save them before leaving, or discard them and continue."
	errorMessage={leaveGuard.error}
	confirmLabel="Save changes"
	pendingLabel="Saving…"
	confirming={leaveGuard.saving}
	onConfirm={() => leaveGuard.saveAndLeave()}
	secondaryLabel="Discard changes"
	onSecondary={() => leaveGuard.leave()}
/>
