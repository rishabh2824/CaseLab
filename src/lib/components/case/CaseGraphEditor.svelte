<script lang="ts">
import { getPersonaLabel, referralsTo } from "#lib/case/draft.js";
import { fieldDomId } from "#lib/case/fieldPath.js";
import { focusField } from "#lib/case/focusField.js";
import type { CaseGraph } from "#lib/case/graph.svelte.js";
import type { Persona } from "#lib/types.js";
import {
	type CaseIssue,
	type FieldPath,
	PERSONAS_PATH,
	referralPath,
} from "#shared/rules.js";
import Button from "../ui/Button.svelte";
import ConfirmDialog from "../ui/ConfirmDialog.svelte";
import FormField, { INPUT_CLASS } from "../ui/FormField.svelte";
import PersonaDiagram from "./PersonaDiagram.svelte";
import PersonaFields from "./PersonaFields.svelte";

type Props = {
	graph: CaseGraph;
	// The problems currently showing, which the diagram marks.
	issues: CaseIssue[];
	errorFor: (path: FieldPath) => string | undefined;
	disabled: boolean;
	selectedId: string | null;
};

let {
	graph,
	issues,
	errorFor,
	disabled,
	selectedId = $bindable(),
}: Props = $props();

// The persona in the editor below the diagram, falling back to the first starting persona once the chosen one is gone.
const selected = $derived(
	graph.byId.get(selectedId ?? "") ?? graph.byId.get(graph.roots[0] ?? ""),
);
// Where the open persona sits in the graph. Binding straight to graph.personas[...] would make Svelte warn, because the graph belongs to the case form, so the editor below binds through a getter and a setter that writes back here.
const selectedIndex = $derived(
	graph.personas.findIndex((persona) => persona.id === selected?.id),
);
const incoming = $derived(
	selected ? referralsTo(graph.referrals, selected.id) : [],
);

// A persona waiting on the confirm dialog because removing it takes others with it.
let pendingRemoval = $state<{ persona: Persona; others: number } | null>(null);

// Returns the persona's display name, for a persona that may not exist.
const labelOf = (persona: Persona | undefined): string =>
	getPersonaLabel(persona ?? { name: "" }, "Unnamed persona");

// Adds a starting persona and opens it.
function addRoot(): void {
	selectedId = graph.addRoot().id;
}

// Adds a persona referred by the given one and opens it.
function addReferral(fromId: string): void {
	selectedId = graph.addReferral(fromId).persona.id;
}

// Opens the referred persona with the clicked referral's condition focused.
function selectReferral(fromId: string, toId: string): void {
	selectedId = toId;
	void focusField(referralPath(fromId, toId));
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

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-end gap-4">
		{#if errorFor(PERSONAS_PATH)}
			<p class="text-xs font-medium text-brand">{errorFor(PERSONAS_PATH)}</p>
		{/if}
		<Button id={fieldDomId(PERSONAS_PATH)} size="sm" onclick={addRoot} {disabled} class="shrink-0">
			+ Add starting persona
		</Button>
	</div>

	{#if selected}
		<PersonaDiagram
			{graph}
			selectedId={selected.id}
			{issues}
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
					<Button size="sm" onclick={() => addReferral(selected.id)}>
						+ Add referral
					</Button>
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
				{@const path = referralPath(referral.fromId, referral.toId)}
				{@const fieldId = fieldDomId(path)}
				{@const parentLabel = labelOf(graph.byId.get(referral.fromId))}
				<FormField
					label="When should {parentLabel} refer the student to this persona?"
					help="{parentLabel} decides from the conversation. You can also add how {parentLabel} should introduce them."
					id={fieldId}
					required
					error={errorFor(path)}
				>
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
				<PersonaFields bind:persona={() => selected, (next) => (graph.personas[selectedIndex] = next)} {errorFor} />
			{/key}
		</fieldset>
	{:else}
		<p class="py-6 text-center text-sm text-stone">Add a starting persona to begin.</p>
	{/if}
</div>

<ConfirmDialog
	open={pendingRemoval !== null}
	onClose={() => (pendingRemoval = null)}
	title="Remove {labelOf(pendingRemoval?.persona)}?"
	description="This also removes {pendingRemoval?.others} {pendingRemoval?.others === 1 ? 'persona' : 'personas'} the student can only reach through them."
	confirmLabel="Remove"
	pendingLabel="Removing…"
	onConfirm={confirmRemove}
/>
