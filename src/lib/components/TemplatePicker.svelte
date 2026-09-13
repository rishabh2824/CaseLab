<script lang="ts">
import { useMutation, useQuery } from "convex-svelte";
import { toast } from "svelte-sonner";
import { getErrorMessage } from "$lib/errors.js";
import type { CaseSummary } from "$lib/types.js";
import { api } from "../../../convex/_generated/api.js";
import DestructiveConfirmDialog from "./DestructiveConfirmDialog.svelte";

type Props = {
	mode?: "template" | "edit";
};

let { mode = "template" }: Props = $props();

// A live subscription, not a fetch-once cache: Convex pushes an updated list to every
// subscriber automatically whenever a case is created/deleted/edited (including from
// deleteCase below), so there's no manual invalidate-and-refetch bookkeeping to maintain.
const casesQuery = useQuery(api.api.cases.listAll, {});
const deleteCase = useMutation(api.api.cases.deleteCase);

let pendingDelete = $state<CaseSummary | null>(null);
let isDeleting = $state(false);

function caseHref(caseItem: CaseSummary): string {
	return mode === "edit"
		? `/admin/cases/${caseItem._id}/edit`
		: `/admin/cases/new?template=${caseItem._id}`;
}

// No stopPropagation here: this button sits in a sibling <div> below the
// open-for-edit button, not nested inside it, so a click here was never
// going to reach that button's own handler regardless.
function requestDelete(caseItem: CaseSummary) {
	pendingDelete = caseItem;
}

async function confirmDelete(): Promise<void> {
	const caseItem = pendingDelete;
	if (!caseItem) return;
	isDeleting = true;
	try {
		await deleteCase({ caseId: caseItem._id });
		pendingDelete = null;
	} catch (err) {
		toast(getErrorMessage(err, "Failed to delete case."));
	} finally {
		isDeleting = false;
	}
}

const isEditMode = $derived(mode === "edit");
</script>

<div class="relative min-h-screen overflow-hidden bg-parchment px-6 py-10">
	<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>
	<div class="relative z-10 mx-auto max-w-4xl">
		<div class="max-w-2xl">
			<div class="flex items-center gap-3">
				<span class="h-px w-8 bg-line"></span>
				<p class="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
					{isEditMode ? 'Edit Case' : 'Choose Template'}
				</p>
			</div>
			<h1 class="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
				{isEditMode ? 'Select a case to edit' : 'Select an existing case'}
			</h1>
			<p class="mt-4 text-sm leading-6 text-stone">
				{isEditMode
					? 'The selected case will open in the form with all of its current details so you can edit it directly.'
					: 'The selected case will be copied into a new form. Saving it will create a brand-new case and leave the original untouched.'}
			</p>
		</div>

		<div class="mt-10 space-y-4">
			{#if casesQuery.isLoading}
				<div class="rounded-2xl border border-line bg-white p-5 text-sm text-stone">
					Loading cases...
				</div>
			{:else if casesQuery.error}
				<div class="rounded-2xl border border-brand/20 bg-brand-tint p-5 text-sm text-brand">
					{getErrorMessage(casesQuery.error, "Failed to load cases.")}
				</div>
			{:else if casesQuery.data.length === 0}
				<div class="rounded-2xl border border-line bg-white p-5 text-sm text-stone">
					No cases found.
				</div>
			{:else}
				{#each casesQuery.data as caseItem (caseItem._id)}
					<div>
						<a
							href={caseHref(caseItem)}
							class="group block w-full rounded-2xl border border-line bg-white p-5 text-left shadow-soft transition hover:-translate-y-0.5 hover:border-brand hover:shadow-premium"
						>
							<p class="font-display text-lg font-semibold text-ink transition group-hover:text-brand">
								{caseItem.name}
							</p>
							<p class="mt-1 font-mono text-xs uppercase tracking-[0.18em] text-stone-soft">
								Access code: {caseItem.accessCode}
							</p>
						</a>
						{#if isEditMode}
							<div class="mt-1.5 flex justify-end px-1">
								<button
									type="button"
									onclick={() => requestDelete(caseItem)}
									disabled={isDeleting && pendingDelete?._id === caseItem._id}
									class="text-xs font-semibold text-stone-soft transition hover:text-brand disabled:opacity-60"
								>
									Delete case
								</button>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>

<DestructiveConfirmDialog
	bind:open={() => pendingDelete !== null, (isOpen) => { if (!isOpen) pendingDelete = null }}
	title={pendingDelete ? `Delete "${pendingDelete.name}"?` : ""}
	description="This also frees its access code for reuse. This cannot be undone."
	confirming={isDeleting}
	onConfirm={confirmDelete}
/>
