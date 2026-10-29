<script lang="ts">
import { tick } from "svelte";
import { getPersonaLabel, referralsTo } from "#lib/case/draft.js";
import type { CaseGraph } from "#lib/case/graph.svelte.js";
import type { Persona } from "#lib/types.js";
import ConfirmDialog from "./ConfirmDialog.svelte";
import FormField, { INPUT_CLASS } from "./FormField.svelte";
import PersonaDiagram from "./PersonaDiagram.svelte";
import PersonaFields from "./PersonaFields.svelte";

type Props = {
	graph: CaseGraph;
	showFieldErrors: boolean;
	disabled: boolean;
};

let { graph, showFieldErrors, disabled }: Props = $props();

const BUTTON_CLASS =
	"rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60";

let selectedId = $state<string | null>(null);
// The persona in the editor below the diagram, falling back to the first starting persona once the chosen one is gone.
const selected = $derived(
	graph.byId.get(selectedId ?? "") ?? graph.byId.get(graph.roots[0] ?? ""),
);
const incoming = $derived(
	selected ? referralsTo(graph.referrals, selected.id) : [],
);

// A persona waiting on the confirm dialog because removing it takes others with it.
let pendingRemoval = $state<{ persona: Persona; others: number } | null>(null);

// Returns the persona's display name, for a persona that may not exist.
const labelOf = (persona: Persona | undefined): string =>
	getPersonaLabel(persona ?? { name: "" }, "Unnamed persona");

// The id of the field holding a referral's condition, so a click on its arrow can focus it.
const referralFieldId = (fromId: string, toId: string): string =>
	`referral-${fromId}-${toId}`;

// Adds a starting persona and opens it.
function addRoot(): void {
	selectedId = graph.addRoot().id;
}

// Adds a persona referred by the given one and opens it.
function addReferral(fromId: string): void {
	selectedId = graph.addReferral(fromId).persona.id;
}

// Opens the referred persona with the clicked referral's condition focused.
async function selectReferral(fromId: string, toId: string): Promise<void> {
	selectedId = toId;
	await tick();
	document.getElementById(referralFieldId(fromId, toId))?.focus();
}

// Removes the persona straight away, or asks first when others would be removed with it.
function requestRemove(persona: Persona): void {
	const others = graph.removalSet(persona.id).size - 1;
	if (others > 0) pendingRemoval = { persona, others };
	else graph.removePersona(persona.id);
}

// Removes the persona the confirm dialog asked about.
function confirmRemove(): void {
	if (pendingRemoval) graph.removePersona(pendingRemoval.persona.id);
	pendingRemoval = null;
}
</script>

<details class="rounded-2xl border border-line bg-white" open>
	<summary class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink">
		AI Personas
	</summary>
	<div class="flex flex-col gap-4 border-t border-line-soft px-5 py-5">
		<div class="flex items-start justify-between gap-4">
			<p class="text-xs text-stone">
				Students can contact starting personas (filled circles) right away; the rest unlock through referrals.
				Click a persona to edit it. Drag from its right edge onto another persona to add a referral, or click an arrow to edit when it happens.
				Dashed arrows have no condition yet.
			</p>
			<button type="button" onclick={addRoot} {disabled} class="{BUTTON_CLASS} shrink-0">
				+ Add starting persona
			</button>
		</div>
		{#if showFieldErrors && graph.validation.rootsError}
			<p class="text-xs font-medium text-brand">{graph.validation.rootsError}</p>
		{/if}

		{#if selected}
			<PersonaDiagram
				{graph}
				selectedId={selected.id}
				{showFieldErrors}
				{disabled}
				onSelect={(personaId) => (selectedId = personaId)}
				onSelectReferral={selectReferral}
			/>

			<fieldset {disabled} class="flex min-w-0 flex-col gap-4 rounded-xl border border-line-soft bg-cream/40 p-4">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">
						<h3 class="truncate font-display text-lg font-semibold text-ink">{labelOf(selected)}</h3>
						<p class="text-xs text-stone">
							{incoming.length > 0
								? `Referred by ${incoming.map((referral) => labelOf(graph.byId.get(referral.fromId))).join(', ')}`
								: 'Starting persona'}
						</p>
					</div>
					<div class="flex shrink-0 gap-2">
						<button type="button" onclick={() => addReferral(selected.id)} class={BUTTON_CLASS}>
							+ Add referral
						</button>
						<button
							type="button"
							onclick={() => requestRemove(selected)}
							class="rounded-md px-2 py-1 text-xs font-semibold text-stone-soft transition hover:text-brand"
						>
							Remove
						</button>
					</div>
				</div>

				{#each incoming as referral (referral.fromId)}
					{@const fieldId = referralFieldId(referral.fromId, referral.toId)}
					{@const parentLabel = labelOf(graph.byId.get(referral.fromId))}
					<FormField label="When should {parentLabel} refer the student to this persona?" id={fieldId}>
						{#snippet children(field)}
							<textarea
								{...field}
								id={fieldId}
								rows="2"
								placeholder="e.g. once the student asks who approved the budget"
								bind:value={referral.conditions}
								class={INPUT_CLASS}
							></textarea>
							<!-- Unlinking the only referral would strand the persona, so that case is left to Remove. -->
							{#if incoming.length > 1}
								<button
									type="button"
									onclick={() => graph.unlink(referral.fromId, referral.toId)}
									class="self-start text-xs font-semibold text-stone-soft transition hover:text-brand"
								>
									Remove referral from {parentLabel}
								</button>
							{/if}
						{/snippet}
					</FormField>
				{/each}

				{#key selected.id}
					<PersonaFields bind:persona={() => selected, () => {}} {showFieldErrors} />
				{/key}
			</fieldset>
		{:else}
			<p class="py-6 text-center text-sm text-stone">Add a starting persona to begin.</p>
		{/if}
	</div>
</details>

<ConfirmDialog
	open={pendingRemoval !== null}
	onClose={() => (pendingRemoval = null)}
	title="Remove {labelOf(pendingRemoval?.persona)}?"
	description="This also removes {pendingRemoval?.others} {pendingRemoval?.others === 1 ? 'persona' : 'personas'} the student can only reach through them."
	confirmLabel="Remove"
	pendingLabel="Removing…"
	onConfirm={confirmRemove}
/>
