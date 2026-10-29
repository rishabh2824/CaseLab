<script lang="ts">
import type { ComponentProps } from "svelte";
import type PersonaDiagram from "../../src/lib/components/PersonaDiagram.svelte";

// Stands in for the Svelte Flow diagram, which needs browser layout APIs jsdom lacks: a button per persona and per referral, wired to the same callbacks.
let {
	graph,
	onSelect,
	onSelectReferral,
}: ComponentProps<typeof PersonaDiagram> = $props();

const nameOf = (id: string): string => graph.byId.get(id)?.name || "Unnamed";
</script>

<nav aria-label="Personas">
	{#each graph.personas as persona (persona.id)}
		<button type="button" onclick={() => onSelect(persona.id)}>{nameOf(persona.id)}</button>
	{/each}
	{#each graph.referrals as referral (`${referral.fromId}->${referral.toId}`)}
		<button type="button" onclick={() => onSelectReferral(referral.fromId, referral.toId)}>
			{nameOf(referral.fromId)} → {nameOf(referral.toId)}
		</button>
	{/each}
</nav>
