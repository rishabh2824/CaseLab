<script module lang="ts">
export const INPUT_CLASS =
	"w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12";
</script>

<script lang="ts">
import type { Snippet } from "svelte";

type FieldAttributes = {
	"aria-invalid": true | undefined;
	"aria-describedby": string | undefined;
};

type Props = {
	label: string;
	id: string;
	error?: string;
	children: Snippet<[FieldAttributes]>;
};

let { label, id, error, children }: Props = $props();
</script>

<div class="flex flex-col gap-1.5">
	<label for={id} class="text-xs font-medium text-stone-soft">{label}</label>
	{@render children({
		"aria-invalid": error ? true : undefined,
		"aria-describedby": error ? `${id}-error` : undefined,
	})}
	{#if error}
		<p id="{id}-error" class="text-xs font-medium text-brand">{error}</p>
	{/if}
</div>
