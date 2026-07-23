<script lang="ts">
import {
	createEmptyReferral,
	getPersonaLabel,
	normalizeReferral,
} from "$lib/case/Helpers.js";
import type { DraftPersona, PersonaFieldErrors } from "$lib/types.js";

type Props = {
	persona: DraftPersona;
	errors?: PersonaFieldErrors;
};

let { persona, errors = {} }: Props = $props();
const uid = $props.id();

type InputEvent_ = Event & { currentTarget: EventTarget & HTMLInputElement };
type TextAreaEvent = Event & {
	currentTarget: EventTarget & HTMLTextAreaElement;
};

function parseIntOrNull(raw: string): number | null {
	if (raw === "") return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function handlePhotoChange(event: InputEvent_): void {
	persona.profile_photo = event.currentTarget.files?.[0] ?? null;
	event.currentTarget.value = "";
}

function handleFileCountChange(event: InputEvent_): void {
	const count = parseIntOrNull(event.currentTarget.value);
	persona.file_count = typeof count === "number" && count >= 0 ? count : null;
	if (typeof persona.file_count === "number") {
		if (persona.files.length > persona.file_count) {
			persona.files.length = persona.file_count;
		} else {
			while (persona.files.length < persona.file_count) {
				persona.files.push({
					file: null,
					share_conditions: "",
					perceived_contents: "",
				});
			}
		}
	}
}

function handleFileChange(event: InputEvent_, fileIndex: number): void {
	const entry = persona.files[fileIndex];
	if (!entry) return;
	entry.file = event.currentTarget.files?.[0] ?? null;
	event.currentTarget.value = "";
}

function handleReferralOutCountChange(event: InputEvent_): void {
	const count = parseIntOrNull(event.currentTarget.value);
	persona.referral_out_count =
		typeof count === "number" && count >= 0 ? count : null;
	if (typeof persona.referral_out_count !== "number") {
		persona.referrals = [];
	} else if (persona.referrals.length > persona.referral_out_count) {
		persona.referrals.length = persona.referral_out_count;
	} else {
		while (persona.referrals.length < persona.referral_out_count) {
			persona.referrals.push(createEmptyReferral());
		}
	}
}

function handleReferralNameChange(
	event: InputEvent_,
	referralIndex: number,
): void {
	const value = event.currentTarget.value;
	const normalized = normalizeReferral(persona.referrals[referralIndex]);
	persona.referrals[referralIndex] = normalized;
	normalized.name = value;
	normalized.persona.name = value;
}

function handleReferralConditionsChange(
	event: TextAreaEvent,
	referralIndex: number,
): void {
	const normalized = normalizeReferral(persona.referrals[referralIndex]);
	persona.referrals[referralIndex] = normalized;
	normalized.conditions = event.currentTarget.value;
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

	<div class="flex flex-col gap-1.5">
		<label for="{uid}-file-count" class="text-xs font-medium text-stone-soft">How many files does this persona have access to?</label>
		<input
			id="{uid}-file-count"
			type="number"
			min="0"
			step="1"
			placeholder="Leave empty for 0"
			value={persona.file_count ?? ''}
			oninput={handleFileCountChange}
			class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
		/>
		{#if errors.fileCount}<p class="text-xs font-medium text-brand">{errors.fileCount}</p>{/if}
	</div>

	{#if typeof persona.file_count === 'number' && persona.file_count > 0}
		<div class="flex flex-col gap-3">
			{#each Array.from({ length: persona.file_count }) as _, fileIndex (fileIndex)}
				{@const fileEntry = persona.files[fileIndex] ?? { file: null, share_conditions: '', perceived_contents: '' }}
				<details class="rounded-xl border border-line-soft bg-cream/40">
					<summary class="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-ink">
						File {fileIndex + 1}
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

	<div class="flex flex-col gap-1.5">
		<label for="{uid}-referral-out-count" class="text-xs font-medium text-stone-soft">How many people does this persona refer out?</label>
		<input
			id="{uid}-referral-out-count"
			type="number"
			min="0"
			step="1"
			placeholder="Leave empty for none"
			value={persona.referral_out_count ?? ''}
			oninput={handleReferralOutCountChange}
			class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
		/>
		{#if errors.referralOutCount}<p class="text-xs font-medium text-brand">{errors.referralOutCount}</p>{/if}
	</div>

	{#if typeof persona.referral_out_count === 'number' && persona.referral_out_count > 0}
		<div class="flex flex-col gap-3">
			{#each Array.from({ length: persona.referral_out_count }) as _, referralIndex (referralIndex)}
				{@const referral = normalizeReferral(persona.referrals[referralIndex])}
				<details class="rounded-xl border border-line-soft bg-cream/40">
					<summary class="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-ink">
						{getPersonaLabel({ name: referral.name }, 'Referred Persona')}
					</summary>
					<div class="flex flex-col gap-3 border-t border-line-soft px-4 py-4">
						<div class="flex flex-col gap-1.5">
							<label for="{uid}-referral-{referralIndex}-name" class="text-xs font-medium text-stone-soft">Name</label>
							<input
								id="{uid}-referral-{referralIndex}-name"
								type="text"
								placeholder="Enter name"
								value={referral.name}
								oninput={(event) => handleReferralNameChange(event, referralIndex)}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							/>
						</div>
						<div class="flex flex-col gap-1.5">
							<label for="{uid}-referral-{referralIndex}-conditions" class="text-xs font-medium text-stone-soft">Describe the referral conditions</label>
							<textarea
								id="{uid}-referral-{referralIndex}-conditions"
								rows="2"
								placeholder="Describe the referral conditions"
								value={referral.conditions}
								oninput={(event) => handleReferralConditionsChange(event, referralIndex)}
								class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
							></textarea>
						</div>
					</div>
				</details>
			{/each}
		</div>
	{/if}
</div>
