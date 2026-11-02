<script lang="ts">
import { numberInputValue } from "#lib/case/draft.js";
import { fieldDomId } from "#lib/case/fieldPath.js";
import type { Persona } from "#lib/types.js";
import { type FieldPath, personaPath } from "#shared/rules.js";
import FileField from "../ui/FileField.svelte";
import FormField, { INPUT_CLASS } from "../ui/FormField.svelte";
import PersonaFileList from "./PersonaFileList.svelte";

type Props = {
	persona: Persona;
	errorFor: (path: FieldPath) => string | undefined;
};

let { persona = $bindable(), errorFor }: Props = $props();

const namePath = $derived(personaPath(persona.id, "name"));
const rolePath = $derived(personaPath(persona.id, "role"));
const factsPath = $derived(personaPath(persona.id, "knownFacts"));
const availabilityPath = $derived(
	personaPath(persona.id, "availabilityMinutes"),
);
const nameId = $derived(fieldDomId(namePath));
const roleId = $derived(fieldDomId(rolePath));
const photoId = $derived(fieldDomId(personaPath(persona.id, "profilePhoto")));
const factsId = $derived(fieldDomId(factsPath));
const traitsId = $derived(
	fieldDomId(personaPath(persona.id, "personalityTraits")),
);
const availabilityId = $derived(fieldDomId(availabilityPath));
</script>
<div class="flex flex-col gap-4">
	<div class="grid gap-4 sm:grid-cols-2">
		<FormField
			label="Persona name"
			help="Students see this in their contact list."
			id={nameId}
			required
			error={errorFor(namePath)}
		>
			{#snippet children(field)}
				<input
					{...field}
					id={nameId}
					type="text"
					required
					placeholder="e.g. Mary Chen"
					bind:value={persona.name}
					class={INPUT_CLASS}
				/>
			{/snippet}
		</FormField>

		<FormField
			label="Title/Role"
			help="Students see this under the name, and the persona speaks from this role."
			id={roleId}
			required
			error={errorFor(rolePath)}
		>
			{#snippet children(field)}
				<input
					{...field}
					id={roleId}
					type="text"
					required
					placeholder="e.g. CFO"
					bind:value={persona.role}
					class={INPUT_CLASS}
				/>
			{/snippet}
		</FormField>
	</div>

	<div class="grid gap-4 sm:grid-cols-2">
		<FileField
			label="Profile photo"
			help="Shown to students in their contact list."
			id={photoId}
			accept="image/*"
			value={persona.profilePhoto}
			onChange={(file) => (persona.profilePhoto = file)}
			existingLabel="Existing photo"
		/>

		<FormField
			label="Available for (minutes)"
			help="How long students can message this persona. Starting personas count from the start of the simulation, referred ones from when they unlock. Blank means no limit."
			id={availabilityId}
			error={errorFor(availabilityPath)}
		>
			{#snippet children(field)}
				<input
					{...field}
					id={availabilityId}
					type="number"
					min="1"
					step="1"
					placeholder="No limit"
					value={persona.availabilityMinutes ?? ''}
					oninput={(event) => {
						persona.availabilityMinutes = numberInputValue(event.currentTarget)
					}}
					class={INPUT_CLASS}
				/>
			{/snippet}
		</FormField>
	</div>

	<FormField
		label="What this persona knows"
		help="Private to this persona. It can only answer from this and the case brief and background; for anything else it says it doesn't know."
		id={factsId}
		required
		error={errorFor(factsPath)}
	>
		{#snippet children(field)}
			<textarea
				{...field}
				id={factsId}
				rows="3"
				required
				placeholder="e.g. Approved the Q3 budget. Thinks the vendor contract is overpriced."
				bind:value={persona.knownFacts}
				class={INPUT_CLASS}
			></textarea>
		{/snippet}
	</FormField>

	<FormField
		label="Personality traits"
		help="How this persona talks and behaves. Other personas don't see this."
		id={traitsId}
	>
		{#snippet children(field)}
			<textarea
				{...field}
				id={traitsId}
				rows="3"
				placeholder="e.g. Direct, a little guarded"
				bind:value={persona.personalityTraits}
				class={INPUT_CLASS}
			></textarea>
		{/snippet}
	</FormField>

	<PersonaFileList personaId={persona.id} bind:files={persona.files} {errorFor} />
</div>
