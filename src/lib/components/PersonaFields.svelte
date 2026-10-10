<script lang="ts">
import {
	getPersonaLabel,
	parseIntOrNull,
	referralsFrom,
} from "#lib/case/draft.js";
import type { CaseGraph } from "#lib/case/graph.svelte.js";
import type { Persona, ReferralEdge } from "#lib/types.js";
import { getPersonaFieldErrors } from "../../../convex/lib/caseRules.js";
import FormField, { INPUT_CLASS } from "./FormField.svelte";
import RemovableSection from "./RemovableSection.svelte";

type Props = {
	persona: Persona;
	graph: CaseGraph;
	showFieldErrors: boolean;
};

let { persona = $bindable(), graph, showFieldErrors }: Props = $props();
const uid = $props.id();

const errors = $derived(showFieldErrors ? getPersonaFieldErrors(persona) : {});

type InputEvent_ = Event & { currentTarget: EventTarget & HTMLInputElement };
type TextAreaEvent = Event & {
	currentTarget: EventTarget & HTMLTextAreaElement;
};

// Stores the chosen profile photo on the persona and resets the file input.
function handlePhotoChange(event: InputEvent_): void {
	persona.profilePhoto = event.currentTarget.files?.[0] ?? null;
	event.currentTarget.value = "";
}

// Adds an empty shareable-file entry to the persona.
function addFile(): void {
	persona.files.push({
		file: null,
		shareConditions: "",
		perceivedContents: "",
	});
}

// Removes the shareable-file entry at the given index.
function removeFile(fileIndex: number): void {
	persona.files.splice(fileIndex, 1);
}

// Attaches the chosen file to a file entry and resets the file input.
function handleFileChange(event: InputEvent_, fileIndex: number): void {
	const entry = persona.files[fileIndex];
	if (!entry) return;
	entry.file = event.currentTarget.files?.[0] ?? null;
	event.currentTarget.value = "";
}

const ownReferrals = $derived(referralsFrom(graph.referrals, persona.id));

// Adds a new referred persona linked from this persona.
function addReferral(): void {
	graph.addReferral(persona.id);
}

// Removes a referral from this persona, along with anything that becomes unreachable.
function removeReferral(referral: ReferralEdge): void {
	graph.removeReferralsFrom(persona.id, [referral.toId]);
}

// Updates a referral's unlock conditions from the textarea.
function handleReferralConditionsChange(
	event: TextAreaEvent,
	referral: ReferralEdge,
): void {
	referral.conditions = event.currentTarget.value;
}
</script>
<div class="flex flex-col gap-4">
	<FormField label="Persona name" id="{uid}-name" error={errors.name}>
		{#snippet children(field)}
			<input
				{...field}
				id="{uid}-name"
				type="text"
				required
				placeholder="Enter persona name"
				bind:value={persona.name}
				class={INPUT_CLASS}
			/>
		{/snippet}
	</FormField>

	<FormField label="Title/Role" id="{uid}-role" error={errors.role}>
		{#snippet children(field)}
			<input
				{...field}
				id="{uid}-role"
				type="text"
				required
				placeholder="Enter title or role"
				bind:value={persona.role}
				class={INPUT_CLASS}
			/>
		{/snippet}
	</FormField>

	<FormField label="Profile photo" id="{uid}-photo">
		{#snippet children(field)}
			<input
				{...field}
				id="{uid}-photo"
				type="file"
				accept="image/*"
				onchange={handlePhotoChange}
				class="{INPUT_CLASS} file:mr-3 file:rounded-md file:border-0 file:bg-cream file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
			/>
			{#if persona.profilePhoto instanceof File}
				<p class="text-xs text-stone-soft">Selected: {persona.profilePhoto.name}</p>
			{:else if persona.profilePhoto}
				<p class="text-xs text-stone-soft">Existing photo: {persona.profilePhoto.fileName}</p>
			{/if}
		{/snippet}
	</FormField>

	<FormField label="Enter Persona Related Information" id="{uid}-known-facts">
		{#snippet children(field)}
			<textarea
				{...field}
				id="{uid}-known-facts"
				rows="3"
				placeholder="Describe the persona's background, facts, and any other relevant information"
				bind:value={persona.knownFacts}
				class={INPUT_CLASS}
			></textarea>
		{/snippet}
	</FormField>

	<FormField label="Personality traits" id="{uid}-personality">
		{#snippet children(field)}
			<textarea
				{...field}
				id="{uid}-personality"
				rows="3"
				placeholder="Describe personality traits"
				bind:value={persona.personalityTraits}
				class={INPUT_CLASS}
			></textarea>
		{/snippet}
	</FormField>

	<FormField
		label="How long is this persona available for?"
		id="{uid}-availability"
		error={errors.availability}
	>
		{#snippet children(field)}
			<input
				{...field}
				id="{uid}-availability"
				type="number"
				min="1"
				step="1"
				placeholder="Leave blank for unlimited"
				value={persona.availabilityMinutes ?? ''}
				oninput={(event) => {
					persona.availabilityMinutes = parseIntOrNull(event.currentTarget.value)
				}}
				class={INPUT_CLASS}
			/>
		{/snippet}
	</FormField>

	<div class="flex items-center justify-between gap-2">
		<span class="text-xs font-medium text-stone-soft">Files this persona has access to</span>
		<button
			type="button"
			onclick={addFile}
			class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand"
		>
			+ Add file
		</button>
	</div>

	{#if persona.files.length > 0}
		<div class="flex flex-col gap-3">
			{#each persona.files as fileEntry, fileIndex (fileIndex)}
				<RemovableSection label="File {fileIndex + 1}" onRemove={() => removeFile(fileIndex)}>
						<FormField label="Upload file" id="{uid}-file-{fileIndex}-upload">
							{#snippet children(field)}
								<input
									{...field}
									id="{uid}-file-{fileIndex}-upload"
									type="file"
									onchange={(event) => handleFileChange(event, fileIndex)}
									class="{INPUT_CLASS} file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
								/>
								{#if fileEntry.file instanceof File}
									<p class="text-xs text-stone-soft">Selected: {fileEntry.file.name}</p>
								{:else if fileEntry.file}
									<p class="text-xs text-stone-soft">Existing file: {fileEntry.file.fileName}</p>
								{/if}
							{/snippet}
						</FormField>
						<FormField
							label="Describe the conditions under which the persona will share the file"
							id="{uid}-file-{fileIndex}-conditions"
						>
							{#snippet children(field)}
								<textarea
									{...field}
									id="{uid}-file-{fileIndex}-conditions"
									rows="2"
									placeholder="Describe the conditions"
									bind:value={fileEntry.shareConditions}
									class={INPUT_CLASS}
								></textarea>
							{/snippet}
						</FormField>
						<FormField
							label="What does the persona think is in this file?"
							id="{uid}-file-{fileIndex}-perceived"
						>
							{#snippet children(field)}
								<textarea
									{...field}
									id="{uid}-file-{fileIndex}-perceived"
									rows="2"
									placeholder="Describe perceived contents"
									bind:value={fileEntry.perceivedContents}
									class={INPUT_CLASS}
								></textarea>
							{/snippet}
						</FormField>
				</RemovableSection>
			{/each}
		</div>
	{/if}

	<div class="flex items-center justify-between gap-2">
		<span class="text-xs font-medium text-stone-soft">People this persona refers out</span>
		<button
			type="button"
			onclick={addReferral}
			class="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-brand hover:text-brand"
		>
			+ Add referral
		</button>
	</div>

	{#if ownReferrals.length > 0}
		<div class="flex flex-col gap-3">
			{#each ownReferrals as referral (referral.toId)}
				{@const referredPersona = graph.byId.get(referral.toId) as Persona}
				<RemovableSection
					label={getPersonaLabel(referredPersona, 'Referred Persona')}
					onRemove={() => removeReferral(referral)}
				>
						<FormField label="Name" id="{uid}-referral-{referral.toId}-name">
							{#snippet children(field)}
								<input
									{...field}
									id="{uid}-referral-{referral.toId}-name"
									type="text"
									placeholder="Enter name"
									bind:value={referredPersona.name}
									class={INPUT_CLASS}
								/>
							{/snippet}
						</FormField>
						<FormField
							label="Describe the referral conditions"
							id="{uid}-referral-{referral.toId}-conditions"
						>
							{#snippet children(field)}
								<textarea
									{...field}
									id="{uid}-referral-{referral.toId}-conditions"
									rows="2"
									placeholder="Describe the referral conditions"
									value={referral.conditions}
									oninput={(event) => handleReferralConditionsChange(event, referral)}
									class={INPUT_CLASS}
								></textarea>
							{/snippet}
						</FormField>
				</RemovableSection>
			{/each}
		</div>
	{/if}
</div>
