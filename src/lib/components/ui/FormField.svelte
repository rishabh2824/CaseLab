<script module lang="ts">
export const INPUT_CLASS =
	"w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import Hint, { HINT_CLASS } from "./Hint.svelte";

type FieldAttributes = {
	"aria-invalid": true | undefined;
	"aria-describedby": string | undefined;
};

type Props = {
	label: string;
	// Shown when the title is hovered. Every field has one, so the form can explain itself without taking up space.
	help: string;
	id: string;
	required?: boolean;
	error?: string;
	children: Snippet<[FieldAttributes]>;
};

let { label, help, id, required = false, error, children }: Props = $props();

// A pseudo-element, so the mark stays out of the field's accessible name.
const REQUIRED_MARK_CLASS = "after:ml-0.5 after:text-brand after:content-['*']";
</script>

<div class="flex min-w-0 flex-col gap-1.5">
	<Hint text={help}>
		{#snippet children(hintProps)}
			<label
				{...hintProps}
				for={id}
				class="{HINT_CLASS} w-fit text-xs font-medium text-stone-soft {required ? REQUIRED_MARK_CLASS : ''}"
			>
				{label}
			</label>
		{/snippet}
	</Hint>
	{@render children({
		"aria-invalid": error ? true : undefined,
		"aria-describedby": error ? `${id}-error` : undefined,
	})}
	{#if error}
		<p id="{id}-error" class="text-xs font-medium text-brand">{error}</p>
	{/if}
</div>
