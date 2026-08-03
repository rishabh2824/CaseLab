<script lang="ts">
import { getPersonaLabel } from "$lib/case/draft.js";
import type { CaseGraph } from "$lib/case/graph.svelte.js";
import type { Persona } from "$lib/types.js";
import PersonaFields from "./PersonaFields.svelte";

type Props = {
	graph: CaseGraph;
	showFieldErrors: boolean;
	revealErrors: () => void;
};

let { graph, showFieldErrors, revealErrors }: Props = $props();

const graphValidation = $derived(graph.validate());
const rootPersonasError = $derived(graphValidation.rootsError);
const personaErrors = $derived(graphValidation.personaErrors);

function addRoot(): void {
	revealErrors();
	graph.addRoot();
}

// Removing a root discards its whole subtree — every persona only reachable
// from this root, not also reachable from some other kept root or referral.
function removeRoot(rootId: string): void {
	revealErrors();
	graph.removeSubtree(rootId);
}
</script>

<details class="rounded-2xl border border-line bg-white" open>
	<summary class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink">
		AI Personas
	</summary>
	<div class="flex flex-col gap-3 border-t border-line-soft px-5 py-5">
		<div class="flex items-center justify-between gap-2">
			<span class="text-xs font-medium text-stone-soft">Personas not referred by anyone else</span>
			<button
				type="button"
				onclick={addRoot}
				class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand"
			>
				+ Add root persona
			</button>
		</div>
		{#if showFieldErrors && rootPersonasError}
			<p class="text-xs font-medium text-brand">{rootPersonasError}</p>
		{/if}
		{#each graph.roots as rootId, index (rootId)}
			{@const persona = graph.byId.get(rootId) as Persona}
			{@const personaLabel = getPersonaLabel(persona, `Persona ${index + 1}`)}
			<details class="rounded-xl border border-line-soft bg-cream/40">
				<summary class="flex cursor-pointer select-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-ink">
					<span>{personaLabel}</span>
					<button
						type="button"
						onclick={(event) => { event.preventDefault(); removeRoot(rootId); }}
						class="rounded-md px-2 py-1 text-xs font-semibold text-stone-soft transition hover:text-brand"
					>
						Remove
					</button>
				</summary>
				<div class="border-t border-line-soft px-4 py-4">
					<PersonaFields
						{persona}
						{graph}
						errors={showFieldErrors ? personaErrors[persona.id] : {}}
					/>
				</div>
			</details>
		{/each}
		{#each graph.referredWithParents as item (item.persona.id)}
			<details class="rounded-xl border border-line-soft bg-cream/40">
				<summary class="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-ink">
					{item.label} &larr; {item.parentLabel}
				</summary>
				<div class="border-t border-line-soft px-4 py-4">
					<PersonaFields
						persona={item.persona}
						{graph}
						errors={showFieldErrors ? personaErrors[item.persona.id] : {}}
					/>
				</div>
			</details>
		{/each}
	</div>
</details>
