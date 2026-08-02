<script lang="ts">
import { getPersonaLabel } from "$lib/case/Helpers.js";
import type { DraftPersona } from "$lib/types.js";
import ReadOnlyField from "./ReadOnlyField.svelte";

type Props = { persona: DraftPersona };

let { persona }: Props = $props();
</script>

<div class="flex flex-col gap-4">
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
		<ReadOnlyField label="Persona name" value={persona.name} />
		<ReadOnlyField label="Title/Role" value={persona.role} />
	</div>

	{#if !(persona.profile_photo instanceof File) && persona.profile_photo}
		<ReadOnlyField label="Profile photo" value={persona.profile_photo.file_name} />
	{/if}

	<ReadOnlyField label="Persona background & known facts" value={persona.known_facts} />
	<ReadOnlyField label="Personality traits" value={persona.personality_traits} />

	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
		<ReadOnlyField
			label="Available for"
			value={persona.availability_minutes}
			placeholder="Unlimited"
		/>
		<ReadOnlyField
			label="Files this persona can share"
			value={persona.files.length > 0 ? persona.files.length : null}
			placeholder="None"
		/>
	</div>

	{#if persona.files.length > 0}
		<div class="flex flex-col gap-3">
			{#each persona.files as fileEntry, fileIndex (fileIndex)}
				<div class="rounded-xl border border-line-soft bg-white px-4 py-3">
					<p class="text-sm font-semibold text-ink">
						File {fileIndex + 1}{!(fileEntry.file instanceof File) && fileEntry.file
							? `: ${fileEntry.file.file_name}`
							: ''}
					</p>
					<div class="mt-2 flex flex-col gap-2">
						<ReadOnlyField label="Shared when" value={fileEntry.share_conditions} placeholder="No conditions set" />
						<ReadOnlyField
							label="Persona believes the file contains"
							value={fileEntry.perceived_contents}
						/>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if persona.referrals.length > 0}
		<div class="flex flex-col gap-3">
			<span class="text-xs font-medium text-stone-soft">Refers out to</span>
			{#each persona.referrals as referral, referralIndex (referralIndex)}
				<div class="rounded-xl border border-line-soft bg-white px-4 py-3">
					<p class="text-sm font-semibold text-ink">
						{getPersonaLabel({ name: referral.name }, 'Referred Persona')}
					</p>
					<div class="mt-2">
						<ReadOnlyField
							label="Referral conditions"
							value={referral.conditions}
							placeholder="No conditions set"
						/>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
