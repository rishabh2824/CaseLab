<script lang="ts">
import { Popover } from "bits-ui";
import type { CaseDraft } from "#lib/case/caseDraft.svelte.js";
import { isSelectableCollaborator, parseIntOrNull } from "#lib/case/draft.js";
import type { AdminRow } from "#lib/types.js";
import { RUN_LIFETIME_MINUTES } from "../../../convex/lib/constants.js";
import FormField, { INPUT_CLASS } from "./FormField.svelte";

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

// A field's error shows once the user has typed in it, or once errors are revealed form-wide.
const errors = $derived(
	Object.fromEntries(
		Object.entries(draft.errors).filter(
			([field]) => draft.showErrors || draft.touched[field],
		),
	) as typeof draft.errors,
);
</script>

<details class="rounded-2xl border border-line bg-white" open>
	<summary class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink">
		Case Information
	</summary>
	<div class="flex flex-col gap-4 border-t border-line-soft px-5 py-5">
		<FormField label="Case name" id="case-name" error={errors.caseName}>
			{#snippet children(field)}
				<input
					{...field}
					id="case-name"
					type="text"
					required
					placeholder="Enter case name"
					bind:value={draft.caseName}
					oninput={() => draft.touch("caseName")}
					class={INPUT_CLASS}
				/>
			{/snippet}
		</FormField>

		<FormField label="Initial brief" id="initial-brief" error={errors.initialBrief}>
			{#snippet children(field)}
				<textarea
					{...field}
					id="initial-brief"
					rows="3"
					required
					placeholder="Summarize the initial brief"
					bind:value={draft.initialBrief}
					oninput={() => draft.touch("initialBrief")}
					class={INPUT_CLASS}
				></textarea>
			{/snippet}
		</FormField>

		<FormField label="Enter Case Background" id="common-information">
			{#snippet children(field)}
				<textarea
					{...field}
					id="common-information"
					rows="3"
					placeholder="Describe the common information"
					bind:value={draft.commonInformation}
					class={INPUT_CLASS}
				></textarea>
			{/snippet}
		</FormField>

		<FormField
			label="Simulation duration (Minutes)"
			id="simulation-duration"
			error={errors.simulationDuration}
		>
			{#snippet children(field)}
				<input
					{...field}
					id="simulation-duration"
					type="number"
					min="1"
					max={RUN_LIFETIME_MINUTES}
					step="1"
					placeholder="Leave empty for unlimited"
					value={draft.simulationDurationMinutes ?? ''}
					oninput={(event) => {
						draft.touch("simulationDuration")
						draft.simulationDurationMinutes = parseIntOrNull(event.currentTarget.value)
					}}
					class={INPUT_CLASS}
				/>
			{/snippet}
		</FormField>

		<FormField label="Access code" id="access-code" error={errors.accessCode}>
			{#snippet children(field)}
				<input
					{...field}
					id="access-code"
					type="text"
					required
					placeholder="Enter access code"
					bind:value={draft.accessCode}
					oninput={() => draft.touch("accessCode")}
					class={INPUT_CLASS}
				/>
			{/snippet}
		</FormField>

		<div class="flex flex-col gap-1.5">
			<span class="text-xs font-medium text-stone-soft">Add collaborators</span>
			<p class="text-xs text-stone">
				Collaborators get full edit access to this case, same as the owner.
			</p>
			<Popover.Root>
				<Popover.Trigger
					class="flex w-fit items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition hover:border-brand hover:text-brand"
				>
					Add collaborators
					{#if draft.collaboratorAdminIds.length > 0}
						<span class="rounded-full bg-brand-tint px-2 py-0.5 text-xs font-semibold text-brand">
							{draft.collaboratorAdminIds.length} selected
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
									<label class="flex items-center gap-2 text-sm text-ink-soft">
										<input
											type="checkbox"
											checked={draft.collaboratorAdminIds.includes(admin._id)}
											onchange={(event) => {
												const checked = event.currentTarget.checked
												draft.collaboratorAdminIds = checked
													? [...draft.collaboratorAdminIds, admin._id]
													: draft.collaboratorAdminIds.filter((id) => id !== admin._id)
											}}
											class="h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
										/>
										<span>{admin.name || admin.email}</span>
									</label>
								{/each}
							</div>
						{/if}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		</div>
	</div>
</details>
