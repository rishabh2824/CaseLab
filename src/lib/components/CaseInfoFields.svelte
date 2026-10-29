<script lang="ts">
import { Popover } from "bits-ui";
import type { CaseDraft } from "#lib/case/caseDraft.svelte.js";
import { parseIntOrNull } from "#lib/case/draft.js";
import type { AdminRow, CollaboratorAccess } from "#lib/types.js";
import { isSelectableCollaborator } from "../../../convex/lib/caseRules.js";
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

// Stores the chosen teaching notes file on the draft and resets the file input.
function handleNotesChange(
	event: Event & { currentTarget: EventTarget & HTMLInputElement },
): void {
	draft.teachingNotes = event.currentTarget.files?.[0] ?? null;
	event.currentTarget.value = "";
}

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

		<FormField label="Teaching notes" id="teaching-notes">
			{#snippet children(field)}
				<input
					{...field}
					id="teaching-notes"
					type="file"
					onchange={handleNotesChange}
					class="{INPUT_CLASS} file:mr-3 file:rounded-md file:border-0 file:bg-cream file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink"
				/>
				{#if draft.teachingNotes}
					<p class="flex items-center gap-3 text-xs text-stone-soft">
						{#if draft.teachingNotes instanceof File}
							<span>Selected: {draft.teachingNotes.name}</span>
						{:else if draft.teachingNotesUrl}
							<a
								href={draft.teachingNotesUrl}
								target="_blank"
								rel="noreferrer"
								class="font-semibold text-ink underline decoration-ink/30 underline-offset-2 transition hover:decoration-ink"
							>
								{draft.teachingNotes.fileName}
							</a>
						{:else}
							<span>Existing file: {draft.teachingNotes.fileName}</span>
						{/if}
						<button
							type="button"
							aria-label="Remove teaching notes"
							onclick={() => (draft.teachingNotes = null)}
							class="font-semibold transition hover:text-brand"
						>
							Remove
						</button>
					</p>
				{/if}
			{/snippet}
		</FormField>

		<div class="flex flex-col gap-1.5">
			<span class="text-xs font-medium text-stone-soft">Add collaborators</span>
			<p class="text-xs text-stone">
				Edit collaborators can change this case like the owner. View-only collaborators can read it and copy it as a template.
			</p>
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
	</div>
</details>
