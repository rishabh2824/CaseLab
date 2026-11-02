<script module lang="ts">
// Marks a title as having hover help.
export const HINT_CLASS =
	"cursor-help underline decoration-stone-soft/50 decoration-dotted underline-offset-2";
</script>

<script lang="ts">
import { Tooltip } from "bits-ui";
import type { Snippet } from "svelte";

type Props = {
	text: string;
	// Renders the title, which must spread these props onto its element.
	children: Snippet<[Record<string, unknown>]>;
};

let { text, children }: Props = $props();
</script>

<Tooltip.Provider delayDuration={150}>
	<Tooltip.Root>
		<Tooltip.Trigger tabindex={-1}>
			{#snippet child({ props })}
				{@render children(props)}
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Portal>
			<Tooltip.Content
				align="start"
				sideOffset={6}
				class="z-50 max-w-xs rounded-lg bg-ink px-3 py-2 text-xs leading-relaxed text-white shadow-soft"
			>
				{text}
			</Tooltip.Content>
		</Tooltip.Portal>
	</Tooltip.Root>
</Tooltip.Provider>
