<script lang="ts">
import { useMutation, useQuery } from "convex-svelte";
import { api } from "#convex/api.js";
import CaseList from "#lib/components/case/CaseList.svelte";
import TemplateToggle from "#lib/components/case/TemplateToggle.svelte";
import DeleteDialog from "#lib/components/ui/DeleteDialog.svelte";
import type { CaseSummary } from "#lib/types.js";

const casesQuery = useQuery(api.cases.listAll, {});
const deleteCase = useMutation(api.cases.deleteCase);

let pendingDelete = $state<CaseSummary | null>(null);
</script>

<CaseList
	eyebrow="Edit Case"
	title="Select a case to edit"
	description="The selected case will open in the form with all of its current details so you can edit it directly."
	query={casesQuery}
	href={(item) => `/admin/cases/${item._id}`}
>
	{#snippet overlay(item)}
		<TemplateToggle caseId={item._id} isTemplate={item.isTemplate} />
	{/snippet}
	{#snippet footer(item)}
		{#if item.canEdit}
			<div class="mt-2 flex items-center justify-end gap-3">
				<button
					type="button"
					onclick={() => (pendingDelete = item)}
					class="text-xs font-semibold text-stone-soft transition hover:text-brand"
				>
					Delete case
				</button>
			</div>
		{/if}
	{/snippet}
</CaseList>

<DeleteDialog
	bind:item={pendingDelete}
	title={(item) => `Delete "${item.name}"?`}
	description="This also frees its access code for reuse. This cannot be undone."
	failureMessage="Failed to delete case."
	onDelete={(item) => deleteCase({ caseId: item._id })}
/>
