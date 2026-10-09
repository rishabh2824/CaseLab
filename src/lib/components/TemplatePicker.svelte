<script lang="ts">
import { useMutation, useQuery } from "convex-svelte";
import { toast } from "svelte-sonner";
import { getErrorMessage } from "#lib/errors.js";
import type { CaseSummary } from "#lib/types.js";
import { api } from "../../../convex/_generated/api.js";
import DemoToggle from "./DemoToggle.svelte";
import DestructiveConfirmDialog from "./DestructiveConfirmDialog.svelte";
import PageHeader from "./PageHeader.svelte";

type Mode = "template" | "edit" | "demo";
type Props = {
	mode?: Mode;
};
type ListedCase = Pick<CaseSummary, "_id" | "name"> & Partial<CaseSummary>;

const COPY: Record<
	Mode,
	{ eyebrow: string; title: string; description: string; empty: string }
> = {
	template: {
		eyebrow: "Choose Template",
		title: "Select an existing case",
		description:
			"The selected case will be copied into a new form. Saving it will create a brand-new case and leave the original untouched.",
		empty: "No cases found.",
	},
	edit: {
		eyebrow: "Edit Case",
		title: "Select a case to edit",
		description:
			"The selected case will open in the form with all of its current details so you can edit it directly.",
		empty: "No cases found.",
	},
	demo: {
		eyebrow: "Demo Cases",
		title: "Browse example cases",
		description:
			"These fully built-out cases are read-only examples of what a complete case looks like.",
		empty: "No demo cases are available yet.",
	},
};

let { mode = "template" }: Props = $props();

const listQuery = useQuery(api.cases.listAll, () =>
	mode === "demo" ? "skip" : {},
);
const demosQuery = useQuery(api.cases.listDemos, () =>
	mode === "demo" ? {} : "skip",
);
const casesQuery = $derived(mode === "demo" ? demosQuery : listQuery);
const cases = $derived<ListedCase[]>(casesQuery.data ?? []);
const copy = $derived(COPY[mode]);
const deleteCase = useMutation(api.cases.deleteCase);

let pendingDelete = $state<ListedCase | null>(null);
let isDeleting = $state(false);

// Returns the link for a case: its edit page, its demo page, or a new case seeded from it.
function caseHref(caseItem: ListedCase): string {
	if (mode === "edit") return `/admin/cases/${caseItem._id}/edit`;
	if (mode === "demo") return `/admin/new/demo/${caseItem._id}`;
	return `/admin/cases/new?template=${caseItem._id}`;
}

// Marks a case as pending deletion so the confirm dialog opens.
function requestDelete(caseItem: ListedCase) {
	pendingDelete = caseItem;
}

// Deletes the pending case, showing a toast if the request fails.
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
		<PageHeader eyebrow={copy.eyebrow} title={copy.title} description={copy.description} />

		<div class="mt-10 space-y-4">
			{#if casesQuery.isLoading}
				<div class="rounded-2xl border border-line bg-white p-5 text-sm text-stone">
					Loading cases...
				</div>
			{:else if casesQuery.error}
				<div class="rounded-2xl border border-brand/20 bg-brand-tint p-5 text-sm text-brand">
					{getErrorMessage(casesQuery.error, "Failed to load cases.")}
				</div>
			{:else if cases.length === 0}
				<div class="rounded-2xl border border-line bg-white p-5 text-sm text-stone">
					{copy.empty}
				</div>
			{:else}
				{#each cases as caseItem (caseItem._id)}
					<div>
						<a
							href={caseHref(caseItem)}
							class="group block w-full rounded-2xl border border-line bg-white p-5 text-left shadow-soft transition hover:-translate-y-0.5 hover:border-brand hover:shadow-premium"
						>
							<p class="font-display text-lg font-semibold text-ink transition group-hover:text-brand">
								{caseItem.name}
							</p>
							{#if caseItem.accessCode}
								<p class="mt-1 font-mono text-xs uppercase tracking-[0.18em] text-stone-soft">
									Access code: {caseItem.accessCode}
								</p>
							{/if}
						</a>
						{#if isEditMode}
							<div class="mt-1.5 flex items-center justify-end gap-3 px-1">
								<DemoToggle caseId={caseItem._id} isDemo={caseItem.isDemo === true} />
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
