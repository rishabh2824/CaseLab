<script lang="ts">
import { getPersonaInitials } from "#lib/format.js";
import type { DisplayContact } from "#lib/student/run.svelte.js";

type Props = {
	contacts: DisplayContact[];
	activeContactId: string | null;
	onSelect: (contactId: string) => void;
};

let { contacts, activeContactId, onSelect }: Props = $props();
</script>

<div>
	<h2 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
		People &amp; Contacts
	</h2>
	<div class="mt-3 space-y-2">
		{#each contacts as contact (contact.id)}
			<button
				type="button"
				onclick={() => onSelect(contact.id)}
				class="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition {contact.id ===
				activeContactId
					? 'border-brand bg-white shadow-soft'
					: 'border-line bg-white/70 hover:border-stone-soft hover:bg-white'}"
			>
				{#if contact.profilePhotoUrl}
					<img
						src={contact.profilePhotoUrl}
						alt="{contact.name} profile"
						class="h-9 w-9 rounded-full object-cover"
					/>
				{:else}
					<div
						class="grid h-9 w-9 place-items-center rounded-full text-xs font-semibold {contact.id ===
						activeContactId
							? 'bg-brand text-white'
							: 'bg-line-soft text-stone'}"
					>
						{getPersonaInitials(contact.name)}
					</div>
				{/if}
				<div class="flex-1">
					<p class="font-semibold text-ink">{contact.name || 'Unnamed'}</p>
					<p class="text-xs text-stone">{contact.role || 'Role'}</p>
					<p class="text-[11px] font-medium {contact.available ? 'text-success' : 'text-stone-soft'}">
						{contact.available ? 'Available' : 'Unavailable'}
					</p>
					{#if typeof contact.availabilityDuration === 'number'}
						<p class="text-[11px] text-stone-soft">Available for {contact.availabilityDuration} min</p>
					{/if}
					{#if typeof contact.expiresIn === 'number' && contact.expiresIn > 0}
						<p class="text-[11px] text-stone-soft">Expires in {contact.expiresIn} min</p>
					{/if}
					{#if contact.chatEnded}
						<p class="text-[11px] text-brand">Conversation ended</p>
					{/if}
					{#if contact.isReferred}
						<p class="text-[11px] text-stone-soft">Referred contact</p>
					{/if}
				</div>
			</button>
		{/each}
	</div>
</div>
