<script lang="ts">
import ToggleLeft from "@lucide/svelte/icons/toggle-left";
import ToggleRight from "@lucide/svelte/icons/toggle-right";
import { useMutation } from "convex-svelte";
import { toast } from "svelte-sonner";
import { getViewerContext } from "#lib/adminViewer.js";
import { getErrorMessage } from "#lib/errors.js";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

type Props = {
	caseId: Id<"cases">;
	isDemo: boolean;
};

let { caseId, isDemo }: Props = $props();

const viewer = getViewerContext();
const setDemo = useMutation(api.cases.setDemo);

let isSaving = $state(false);

// Flips the demo flag, showing a toast if the request fails.
async function toggle(): Promise<void> {
	isSaving = true;
	try {
		await setDemo({ caseId, isDemo: !isDemo });
	} catch (err) {
		toast(getErrorMessage(err, "Failed to update the demo setting."));
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
			aria-checked={isDemo}
			aria-label="Show as a demo case"
			aria-describedby="demo-tip-{caseId}"
			onclick={toggle}
			disabled={isSaving}
			class="rounded-full p-0.5 transition disabled:opacity-60 {isDemo ? 'text-brand' : 'text-stone-soft hover:text-brand'}"
		>
			{#if isDemo}
				<ToggleRight class="h-6 w-6" aria-hidden="true" />
			{:else}
				<ToggleLeft class="h-6 w-6" aria-hidden="true" />
			{/if}
		</button>
		<span
			id="demo-tip-{caseId}"
			role="tooltip"
			class="pointer-events-none invisible absolute bottom-full right-0 z-10 mb-2 w-64 rounded-lg border border-line bg-white px-3 py-2 text-xs leading-5 text-ink-soft opacity-0 shadow-soft transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
		>
			Demo case: when on, every admin can view this case read-only under View demo cases. Its access
			code stays hidden.
		</span>
	</div>
{/if}
