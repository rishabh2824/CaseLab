<script lang="ts">
import { useMutation } from "convex-svelte";
import { toast } from "svelte-sonner";
import { getViewerContext } from "#lib/adminViewer.js";
import { getErrorMessage } from "#lib/errors.js";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

type Props = {
	caseId: Id<"cases">;
	isTemplate: boolean;
};

let { caseId, isTemplate }: Props = $props();

const viewer = getViewerContext();
const setTemplate = useMutation(api.cases.setTemplate);

let isSaving = $state(false);

// Flips the template flag, showing a toast if the request fails.
async function toggle(): Promise<void> {
	isSaving = true;
	try {
		await setTemplate({ caseId, isTemplate: !isTemplate });
	} catch (err) {
		toast(getErrorMessage(err, "Failed to update the template setting."));
	} finally {
		isSaving = false;
	}
}
</script>

{#if viewer.data?.role === "super"}
	<div class="group relative flex items-center">
		<button
			type="button"
			role="switch"
			aria-checked={isTemplate}
			aria-label="Offer as a template"
			aria-describedby="template-tip-{caseId}"
			onclick={toggle}
			disabled={isSaving}
			class="relative h-5 w-10 shrink-0 rounded-full transition disabled:opacity-60 {isTemplate ? 'bg-brand' : 'bg-line hover:bg-stone-soft/60'}"
		>
			<span
				aria-hidden="true"
				class="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform {isTemplate ? 'translate-x-5' : 'translate-x-0'}"
			></span>
		</button>
		<span
			id="template-tip-{caseId}"
			role="tooltip"
			class="pointer-events-none invisible absolute right-0 top-full z-10 mt-2 w-64 rounded-lg border border-line bg-white px-3 py-2 text-xs leading-5 text-ink-soft opacity-0 shadow-soft transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
		>
			Template: lets every admin copy this case as the starting point for a new one. Access code stays hidden.
		</span>
	</div>
{/if}
