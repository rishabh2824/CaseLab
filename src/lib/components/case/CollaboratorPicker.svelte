<script lang="ts">
import { Popover } from "bits-ui";
import type { CaseDraft } from "#lib/case/caseDraft.svelte.js";
import type { AdminRow, CollaboratorAccess } from "#lib/types.js";
import { isSelectableCollaborator } from "#shared/rules.js";
import Hint, { HINT_CLASS } from "../ui/Hint.svelte";

type Props = {
	draft: CaseDraft;
	allAdmins: AdminRow[];
	adminsLoading: boolean;
	effectiveOwnerId: string | null;
};

let { draft, allAdmins, adminsLoading, effectiveOwnerId }: Props = $props();

const selectableAdmins = $derived(
	allAdmins.filter((admin) =>
		isSelectableCollaborator(admin, effectiveOwnerId),
	),
);
</script>

<div class="flex flex-col gap-1.5">
	<Hint text="Edit collaborators can change this case like the owner. View-only collaborators can read it and copy it as a template.">
		{#snippet children(hintProps)}
			<span {...hintProps} class="{HINT_CLASS} w-fit text-xs font-medium text-stone-soft">Collaborators</span>
		{/snippet}
	</Hint>
	<Popover.Root>
		<Popover.Trigger
			class="flex w-fit items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition hover:border-brand hover:text-brand"
		>
			Add collaborators
			{#if draft.collaborators.length > 0}
				<span class="rounded-full bg-brand-tint px-2 py-0.5 text-xs font-semibold text-brand">
					{draft.collaborators.length} selected
				</span>
			{/if}
			<span aria-hidden="true">▾</span>
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content
				class="z-50 w-64 rounded-lg border border-line bg-white p-3 shadow-soft"
				sideOffset={6}
			>
				{#if adminsLoading}
					<p class="text-xs text-stone-soft">Loading admins…</p>
				{:else if selectableAdmins.length === 0}
					<p class="text-xs text-stone-soft">No other admins available to add.</p>
				{:else}
					<div class="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
						{#each selectableAdmins as admin (admin._id)}
							{@const entry = draft.collaborators.find((c) => c.adminId === admin._id)}
							<div class="flex items-center justify-between gap-2">
								<label class="flex items-center gap-2 text-sm text-ink-soft">
									<input
										type="checkbox"
										checked={entry !== undefined}
										onchange={(event) => {
											draft.collaborators = event.currentTarget.checked
												? [...draft.collaborators, { adminId: admin._id, access: "edit" }]
												: draft.collaborators.filter((c) => c.adminId !== admin._id)
										}}
										class="h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
									/>
									<span>{admin.name}</span>
								</label>
								{#if entry}
									<select
										aria-label="Access for {admin.name}"
										value={entry.access}
										onchange={(event) => {
											entry.access = event.currentTarget.value as CollaboratorAccess
										}}
										class="rounded-md border border-line bg-white px-1.5 py-0.5 text-xs text-ink-soft"
									>
										<option value="edit">Edit</option>
										<option value="view">View only</option>
									</select>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
</div>
