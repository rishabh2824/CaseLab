<script lang="ts">
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
			class="relative h-5 w-10 shrink-0 rounded-full transition disabled:opacity-60 {isDemo ? 'bg-brand' : 'bg-line hover:bg-stone-soft/60'}"
		>
			<span
				aria-hidden="true"
				class="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform {isDemo ? 'translate-x-5' : 'translate-x-0'}"
			></span>
		</button>
		<span
			id="demo-tip-{caseId}"
			role="tooltip"
			class="pointer-events-none invisible absolute right-0 top-full z-10 mt-2 w-64 rounded-lg border border-line bg-white px-3 py-2 text-xs leading-5 text-ink-soft opacity-0 shadow-soft transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
		>
			Demo Case: Allows other admins to view this case as read only. Access code stays hidden.
		</span>
	</div>
{/if}
