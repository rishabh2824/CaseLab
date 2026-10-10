<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
	label: string;
	onRemove: () => void;
	open?: boolean;
	children: Snippet;
};

let { label, onRemove, open = false, children }: Props = $props();
</script>

<!-- The Remove button sits beside the <details>, not inside its <summary>, so the summary stays free of interactive content. It comes first in the DOM so a parent section's button precedes its nested ones. -->
<div class="relative">
	<button
		type="button"
		onclick={onRemove}
		class="absolute right-3 top-2.5 rounded-md px-2 py-1 text-xs font-semibold text-stone-soft transition hover:text-brand"
	>
		Remove
	</button>
	<details class="rounded-xl border border-line-soft bg-cream/40" {open}>
		<summary class="cursor-pointer select-none px-4 py-3 pr-24 text-sm font-semibold text-ink">
			{label}
		</summary>
		<div class="flex flex-col gap-3 border-t border-line-soft px-4 py-4">
			{@render children()}
		</div>
	</details>
</div>
