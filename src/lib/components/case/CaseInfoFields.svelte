<script lang="ts">
import type { CaseDraft } from "#lib/case/caseDraft.svelte.js";
import { numberInputValue } from "#lib/case/draft.js";
import { fieldDomId } from "#lib/case/fieldPath.js";
import type { AdminRow } from "#lib/types.js";
import { casePath, MAX_DURATION_MINUTES } from "#shared/rules.js";
import FileField from "../ui/FileField.svelte";
import FormField, { INPUT_CLASS } from "../ui/FormField.svelte";
import CollaboratorPicker from "./CollaboratorPicker.svelte";

type Props = {
	draft: CaseDraft;
	allAdmins: AdminRow[];
	adminsLoading: boolean;
	effectiveOwnerId: string | null;
};

let { draft, allAdmins, adminsLoading, effectiveOwnerId }: Props = $props();

const nameId = fieldDomId(casePath("name"));
const briefId = fieldDomId(casePath("brief"));
const durationId = fieldDomId(casePath("duration"));
const accessCodeId = fieldDomId(casePath("accessCode"));
</script>

<div class="flex flex-col gap-4">
	<FormField
		label="Case name"
		help="Students see this during the simulation."
		id={nameId}
		required
		error={draft.errorFor(casePath("name"))}
	>
		{#snippet children(field)}
			<input
				{...field}
				id={nameId}
				type="text"
				required
				placeholder="e.g. Northwind supply costs"
				bind:value={draft.name}
				oninput={() => draft.touch(casePath("name"))}
				class={INPUT_CLASS}
			/>
		{/snippet}
	</FormField>

	<FormField
		label="Student brief"
		help="Shown to students at the start, and also given to every persona. Don't put anything here students shouldn't see."
		id={briefId}
		required
		error={draft.errorFor(casePath("brief"))}
	>
		{#snippet children(field)}
			<textarea
				{...field}
				id={briefId}
				rows="3"
				required
				placeholder="e.g. Supply costs rose 18% this year. Find out why and recommend a fix."
				bind:value={draft.brief}
				oninput={() => draft.touch(casePath("brief"))}
				class={INPUT_CLASS}
			></textarea>
		{/snippet}
	</FormField>

	<FormField
		label="Background for personas"
		help="Given to every persona. Students never see it. Use it for facts everyone in the case would know."
		id="common-information"
	>
		{#snippet children(field)}
			<textarea
				{...field}
				id="common-information"
				rows="3"
				placeholder="e.g. Northwind is a mid-sized distributor based in Madison."
				bind:value={draft.commonInformation}
				class={INPUT_CLASS}
			></textarea>
		{/snippet}
	</FormField>

	<div class="grid gap-4 sm:grid-cols-2">
		<FormField
			label="Time limit (minutes)"
			help="Whole minutes, 1 to {MAX_DURATION_MINUTES}. Leave blank for no timer, but every run still ends after 4 hours."
			id={durationId}
			error={draft.errorFor(casePath("duration"))}
		>
			{#snippet children(field)}
				<input
					{...field}
					id={durationId}
					type="number"
					min="1"
					max={MAX_DURATION_MINUTES}
					step="1"
					placeholder="No timer"
					value={draft.duration ?? ''}
					oninput={(event) => {
						draft.touch(casePath("duration"))
						draft.duration = numberInputValue(event.currentTarget)
					}}
					class={INPUT_CLASS}
				/>
			{/snippet}
		</FormField>

		<FormField
			label="Access code"
			help="Students type this to open the case. Letters only, and no other case can use it."
			id={accessCodeId}
			required
			error={draft.errorFor(casePath("accessCode"))}
		>
			{#snippet children(field)}
				<input
					{...field}
					id={accessCodeId}
					type="text"
					required
					placeholder="e.g. northwind"
					bind:value={draft.accessCode}
					oninput={() => draft.touch(casePath("accessCode"))}
					class={INPUT_CLASS}
				/>
			{/snippet}
		</FormField>
	</div>

	<div class="grid gap-4 sm:grid-cols-2">
		<FileField
			label="Teaching notes"
			help="For admins with access to this case. Students never see this file and personas don't read it."
			id="teaching-notes"
			value={draft.teachingNotes}
			onChange={(file) => (draft.teachingNotes = file)}
			existingLabel="Existing file"
		>
			{#snippet status()}
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
		</FileField>

		<CollaboratorPicker
			{draft}
			{allAdmins}
			{adminsLoading}
			{effectiveOwnerId}
		/>
	</div>
</div>
