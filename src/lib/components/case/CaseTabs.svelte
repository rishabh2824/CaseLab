<script lang="ts">
import { Tabs } from "bits-ui";
import type { Snippet } from "svelte";
import type { CaseTab } from "#lib/case/fieldPath.js";
import Hint, { HINT_CLASS } from "../ui/Hint.svelte";

type Props = {
	active: CaseTab;
	hasIssues: (tab: CaseTab) => boolean;
	info: Snippet;
	personas: Snippet;
};

let { active = $bindable(), hasIssues, info, personas }: Props = $props();
</script>

{#snippet trigger(id: CaseTab, label: string, help?: string)}
	<Tabs.Trigger
		value={id}
		class="-mb-px flex items-center gap-2 border-b-2 border-transparent px-1 pb-2.5 font-display text-lg font-semibold text-stone-soft transition hover:text-ink data-[state=active]:border-brand data-[state=active]:text-ink"
	>
		{#if help}
			<Hint text={help}>
				{#snippet children(hintProps)}
					<span {...hintProps} class={HINT_CLASS}>{label}</span>
				{/snippet}
			</Hint>
		{:else}
			{label}
		{/if}
		{#if hasIssues(id)}
			<span class="h-2 w-2 rounded-full bg-brand" aria-hidden="true"></span>
		{/if}
	</Tabs.Trigger>
{/snippet}

<!-- Only the open tab's content is rendered, because the diagram can't measure itself while hidden. Nothing is lost on switching: every value lives on the draft. -->
<Tabs.Root
	value={active}
	onValueChange={(tab) => (active = tab as CaseTab)}
	class="flex flex-col gap-6"
>
	<Tabs.List class="flex gap-6 border-b border-line">
		{@render trigger("info", "Case Information")}
		{@render trigger(
			"personas",
			"AI Personas",
			"Students can message starting personas right away. Others unlock when a persona refers them. Click a persona to edit it. To add a referral, drag from the dot on a persona's right edge onto another persona. Starting personas can't be referred. Click an arrow to edit when it happens.",
		)}
	</Tabs.List>
	<Tabs.Content value="info">
		{#if active === "info"}{@render info()}{/if}
	</Tabs.Content>
	<Tabs.Content value="personas">
		{#if active === "personas"}{@render personas()}{/if}
	</Tabs.Content>
</Tabs.Root>
