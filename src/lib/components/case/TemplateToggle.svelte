<script lang="ts">
import { Switch } from "bits-ui";
import { useMutation } from "convex-svelte";
import { toast } from "svelte-sonner";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { getViewerContext } from "#lib/adminViewer.js";
import { getErrorMessage } from "#lib/errors.js";
import Hint from "../ui/Hint.svelte";

type Props = {
	caseId: Id<"cases">;
	isTemplate: boolean;
};

let { caseId, isTemplate }: Props = $props();

const viewer = getViewerContext();
const setTemplate = useMutation(api.cases.setTemplate);

let isSaving = $state(false);

// Sets the template flag, showing a toast if the request fails. The switch follows the saved value, so a failure leaves it where it was.
async function save(next: boolean): Promise<void> {
	isSaving = true;
	try {
		await setTemplate({ caseId, isTemplate: next });
	} catch (err) {
		toast(getErrorMessage(err, "Failed to update the template setting."));
	} finally {
		isSaving = false;
	}
}
</script>

{#if viewer.data?.role === "super"}
	<Hint text="Template: lets every admin copy this case as the starting point for a new one. Access code stays hidden.">
		{#snippet children(hintProps)}
			<span {...hintProps} class="flex">
				<Switch.Root
					bind:checked={() => isTemplate, save}
					disabled={isSaving}
					aria-label="Offer as a template"
					class="h-5 w-10 shrink-0 rounded-full bg-line transition hover:bg-stone-soft/60 disabled:opacity-60 data-[state=checked]:bg-brand"
				>
					<Switch.Thumb
						class="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-5"
					/>
				</Switch.Root>
			</span>
		{/snippet}
	</Hint>
{/if}
