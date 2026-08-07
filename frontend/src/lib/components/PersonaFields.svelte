<script lang="ts">
import {
	getPersonaFieldErrors,
	getPersonaLabel,
	parseIntOrNull,
	referralsFrom,
} from "$lib/case/draft.js";
import type { CaseGraph } from "$lib/case/graph.svelte.js";
import type { Persona, ReferralEdge } from "$lib/types.js";

type Props = {
	persona: Persona;
	graph: CaseGraph;
	showFieldErrors: boolean;
};

let { persona, graph, showFieldErrors }: Props = $props();
const uid = $props.id();

// Derived off just this persona, not the whole graph — editing persona #12
// no longer recomputes (or reallocates error objects for) every other
// mounted PersonaFields instance. See graph.svelte.ts's `validation` for the
// graph-wide hasErrors boolean this intentionally doesn't duplicate.
const errors = $derived(showFieldErrors ? getPersonaFieldErrors(persona) : {});

type InputEvent_ = Event & { currentTarget: EventTarget & HTMLInputElement };
type TextAreaEvent = Event & {
	currentTarget: EventTarget & HTMLTextAreaElement;
};

function handlePhotoChange(event: InputEvent_): void {
	persona.profile_photo = event.currentTarget.files?.[0] ?? null;
	event.currentTarget.value = "";
}

function addFile(): void {
	persona.files.push({
		file: null,
		share_conditions: "",
		perceived_contents: "",
	});
}

function removeFile(fileIndex: number): void {
	persona.files.splice(fileIndex, 1);
}

function handleFileChange(event: InputEvent_, fileIndex: number): void {
	const entry = persona.files[fileIndex];
	if (!entry) return;
	entry.file = event.currentTarget.files?.[0] ?? null;
	event.currentTarget.value = "";
}

const ownReferrals = $derived(referralsFrom(graph.referrals, persona.id));

// UX unchanged from before the flat-graph refactor: this always creates a
// brand-new referred persona per added referral, never links to an existing
// one — authoring a second parent for an existing persona isn't exposed here.
function addReferral(): void {
	graph.addReferral(persona.id);
}

function removeReferral(referral: ReferralEdge): void {
	graph.removeReferralsFrom(persona.id, [referral.to_id]);
}

function handleReferralConditionsChange(
	event: TextAreaEvent,
	referral: ReferralEdge,
): void {
	referral.conditions = event.currentTarget.value;
}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-col gap-1.5">
		<label for="{uid}-name" class="text-xs font-medium text-stone-soft">Persona name</label>
		<input
			id="{uid}-name"
			type="text"
			required
			placeholder="Enter persona name"
			bind:value={persona.name}
			class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
		/>
		{#if errors.name}<p class="text-xs font-medium text-brand">{errors.name}</p>{/if}
	</div>

	<div class="flex flex-col gap-1.5">
		<label for="{uid}-role" class="text-xs font-medium text-stone-soft">Title/Role</label>
		<input
			id="{uid}-role"
			type="text"
			required
			placeholder="Enter title or role"
			bind:value={persona.role}
			class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
		/>
		{#if errors.role}<p class="text-xs font-medium text-brand">{errors.role}</p>{/if}
	</div>

	<div class="flex flex-col gap-1.5">
		<label for="{uid}-photo" class="text-xs font-medium text-stone-soft">Profile photo</label>
		<input
			id="{uid}-photo"
			type="file"
			accept="image/*"
			onchange={handlePhotoChange}
			class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-cream file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
		/>
		{#if persona.profile_photo instanceof File}
			<p class="text-xs text-stone-soft">Selected: {persona.profile_photo.name}</p>
		{:else if persona.profile_photo}
			<p class="text-xs text-stone-soft">Existing photo: {persona.profile_photo.file_name}</p>
		{/if}
	</div>

	<div class="flex flex-col gap-1.5">
		<label for="{uid}-known-facts" class="text-xs font-medium text-stone-soft">Enter Persona Related Information</label>
		<textarea
			id="{uid}-known-facts"
			rows="3"
			placeholder="Describe the persona's background, facts, and any other relevant information"
			bind:value={persona.known_facts}
			class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
		></textarea>
	</div>

	<div class="flex flex-col gap-1.5">
		<label for="{uid}-personality" class="text-xs font-medium text-stone-soft">Personality traits</label>
		<textarea
			id="{uid}-personality"
			rows="3"
			placeholder="Describe personality traits"
			bind:value={persona.personality_traits}
			class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
		></textarea>
	</div>

	<div class="flex flex-col gap-1.5">
		<label for="{uid}-availability" class="text-xs font-medium text-stone-soft">How long is this persona available for?</label>
		<input
			id="{uid}-availability"
			type="number"
			min="1"
			step="1"
			placeholder="Leave blank for unlimited"
			value={persona.availability_minutes ?? ''}
			oninput={(event) => {
				persona.availability_minutes = parseIntOrNull(event.currentTarget.value)
			}}
			class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
		/>
		{#if errors.availability}<p class="text-xs font-medium text-brand">{errors.availability}</p>{/if}
	</div>

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
				<details class="rounded-xl border border-line-soft bg-cream/40">
					<summary class="flex cursor-pointer select-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-semibold text-ink">
						<span>File {fileIndex + 1}</span>
						<button
							type="button"
							onclick={(event) => { event.preventDefault(); removeFile(fileIndex); }}
							class="rounded-md px-2 py-1 text-xs font-semibold text-stone-soft transition hover:text-brand"
						>
							Remove
						</button>
					</summary>
					<div class="flex flex-col gap-3 border-t border-line-soft px-4 py-4">
						<div class="flex flex-col gap-1.5">
							<label for="{uid}-file-{fileIndex}-upload" class="text-xs font-medium text-stone-soft">Upload file</label>
							<input
								id="{uid}-file-{fileIndex}-upload"
								type="file"
								onchange={(event) => handleFileChange(event, fileIndex)}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
							/>
							{#if fileEntry.file instanceof File}
								<p class="text-xs text-stone-soft">Selected: {fileEntry.file.name}</p>
							{:else if fileEntry.file}
								<p class="text-xs text-stone-soft">Existing file: {fileEntry.file.file_name}</p>
							{/if}
						</div>
						<div class="flex flex-col gap-1.5">
							<label for="{uid}-file-{fileIndex}-conditions" class="text-xs font-medium text-stone-soft">
								Describe the conditions under which the persona will share the file
							</label>
							<textarea
								id="{uid}-file-{fileIndex}-conditions"
								rows="2"
								placeholder="Describe the conditions"
								bind:value={fileEntry.share_conditions}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							></textarea>
						</div>
						<div class="flex flex-col gap-1.5">
							<label for="{uid}-file-{fileIndex}-perceived" class="text-xs font-medium text-stone-soft">What does the persona think is in this file?</label>
							<textarea
								id="{uid}-file-{fileIndex}-perceived"
								rows="2"
								placeholder="Describe perceived contents"
								bind:value={fileEntry.perceived_contents}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							></textarea>
						</div>
					</div>
				</details>
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
			{#each ownReferrals as referral (referral.to_id)}
				{@const referredPersona = graph.byId.get(referral.to_id) as Persona}
				<details class="rounded-xl border border-line-soft bg-cream/40">
					<summary class="flex cursor-pointer select-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-semibold text-ink">
						<span>{getPersonaLabel(referredPersona, 'Referred Persona')}</span>
						<button
							type="button"
							onclick={(event) => { event.preventDefault(); removeReferral(referral); }}
							class="rounded-md px-2 py-1 text-xs font-semibold text-stone-soft transition hover:text-brand"
						>
							Remove
						</button>
					</summary>
					<div class="flex flex-col gap-3 border-t border-line-soft px-4 py-4">
						<div class="flex flex-col gap-1.5">
							<label for="{uid}-referral-{referral.to_id}-name" class="text-xs font-medium text-stone-soft">Name</label>
							<input
								id="{uid}-referral-{referral.to_id}-name"
								type="text"
								placeholder="Enter name"
								bind:value={referredPersona.name}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
						</div>
						<div class="flex flex-col gap-1.5">
							<label for="{uid}-referral-{referral.to_id}-conditions" class="text-xs font-medium text-stone-soft">Describe the referral conditions</label>
							<textarea
								id="{uid}-referral-{referral.to_id}-conditions"
								rows="2"
								placeholder="Describe the referral conditions"
								value={referral.conditions}
								oninput={(event) => handleReferralConditionsChange(event, referral)}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							></textarea>
						</div>
					</div>
				</details>
			{/each}
		</div>
	{/if}
</div>
