<script lang="ts">
import {
	getPersonaLabel,
	personasById as personasByIdOf,
	referralsFrom,
} from "#lib/case/draft.js";
import type { PersonaPayload, ReferralEdge } from "#lib/types.js";
import ReadOnlyField from "./ReadOnlyField.svelte";

type Props = {
	persona: PersonaPayload;
	personas: PersonaPayload[];
	referrals: ReferralEdge[];
};

let { persona, personas, referrals }: Props = $props();

const personasById = $derived(personasByIdOf(personas));
const ownReferrals = $derived(referralsFrom(referrals, persona.id));
</script>

<div class="flex flex-col gap-4">
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
		<ReadOnlyField label="Persona name" value={persona.name} />
		<ReadOnlyField label="Title/Role" value={persona.role} />
	</div>

	{#if persona.profilePhoto}
		<ReadOnlyField label="Profile photo" value={persona.profilePhoto.fileName} />
	{/if}

	<ReadOnlyField label="Persona background & known facts" value={persona.knownFacts} />
	<ReadOnlyField label="Personality traits" value={persona.personalityTraits} />

	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
		<ReadOnlyField
			label="Available for"
			value={persona.availabilityMinutes}
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
						File {fileIndex + 1}{fileEntry.file
							? `: ${fileEntry.file.fileName}`
							: ''}
					</p>
					<div class="mt-2 flex flex-col gap-2">
						<ReadOnlyField label="Shared when" value={fileEntry.shareConditions} placeholder="No conditions set" />
						<ReadOnlyField
							label="Persona believes the file contains"
							value={fileEntry.perceivedContents}
						/>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if ownReferrals.length > 0}
		<div class="flex flex-col gap-3">
			<span class="text-xs font-medium text-stone-soft">Refers out to</span>
			{#each ownReferrals as referral (referral.toId)}
				{@const referredPersona = personasById.get(referral.toId) as PersonaPayload}
				<div class="rounded-xl border border-line-soft bg-white px-4 py-3">
					<p class="text-sm font-semibold text-ink">
						{getPersonaLabel(referredPersona, 'Referred Persona')}
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
