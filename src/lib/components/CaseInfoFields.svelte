<script lang="ts">
import { Popover } from "bits-ui";
import {
	getCaseInfoErrors,
	isSelectableCollaborator,
	parseIntOrNull,
} from "$lib/case/draft.js";
import type { AdminRow } from "$lib/types.js";

type Props = {
	caseName: string;
	initialBrief: string;
	commonInformation: string;
	simulationDurationMinutes: number | null;
	accessCode: string;
	collaboratorAdminIds: string[];
	maxSimulationDuration: number;
	allAdmins: AdminRow[];
	adminsLoading: boolean;
	effectiveOwnerId: string | null;
	showFieldErrors: boolean;
	revealErrors: () => void;
};

let {
	caseName = $bindable(),
	initialBrief = $bindable(),
	commonInformation = $bindable(),
	simulationDurationMinutes = $bindable(),
	accessCode = $bindable(),
	collaboratorAdminIds = $bindable(),
	maxSimulationDuration,
	allAdmins,
	adminsLoading,
	effectiveOwnerId,
	showFieldErrors,
	revealErrors,
}: Props = $props();

const selectableAdmins = $derived(
	allAdmins.filter((admin) =>
		isSelectableCollaborator(admin, effectiveOwnerId),
	),
);

// Derived off just these scalar fields, not pushed up to CaseForm.svelte via a
// bind:hasErrors + $effect -- CaseForm.svelte computes the same "does this case info have
// any errors" boolean itself, from the exact same getCaseInfoErrors call, the same way
// PersonaFields.svelte's own per-persona `errors` and graph.svelte.ts's graph-wide
// `validation` are two independent readers of one shared pure function rather than one
// pushing its answer up into the other's state. Gated on showFieldErrors here (an empty
// object when it's false) the same way PersonaFields.svelte gates its own `errors` --
// consistently across every field, including simulation duration, which previously showed
// its error regardless of showFieldErrors.
const errors = $derived(
	showFieldErrors
		? getCaseInfoErrors({
				caseName,
				initialBrief,
				accessCode,
				simulationDurationMinutes,
				maxSimulationDuration,
			})
		: {},
);
</script>

<details class="rounded-2xl border border-line bg-white" open>
	<summary class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink">
		Case Information
	</summary>
	<div class="flex flex-col gap-4 border-t border-line-soft px-5 py-5">
		<div class="flex flex-col gap-1.5">
			<label for="case-name" class="text-xs font-medium text-stone-soft">Case name</label>
			<input
				id="case-name"
				type="text"
				required
				placeholder="Enter case name"
				bind:value={caseName}
				oninput={revealErrors}
				class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
			/>
			{#if errors.caseName}
				<p class="text-xs font-medium text-brand">{errors.caseName}</p>
			{/if}
		</div>

		<div class="flex flex-col gap-1.5">
			<label for="initial-brief" class="text-xs font-medium text-stone-soft">Initial brief</label>
			<textarea
				id="initial-brief"
				rows="3"
				required
				placeholder="Summarize the initial brief"
				bind:value={initialBrief}
				oninput={revealErrors}
				class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
			></textarea>
			{#if errors.initialBrief}
				<p class="text-xs font-medium text-brand">{errors.initialBrief}</p>
			{/if}
		</div>

		<div class="flex flex-col gap-1.5">
			<label for="common-information" class="text-xs font-medium text-stone-soft">Enter Case Background</label>
			<textarea
				id="common-information"
				rows="3"
				placeholder="Describe the common information"
				bind:value={commonInformation}
				class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
			></textarea>
		</div>

		<div class="flex flex-col gap-1.5">
			<label for="simulation-duration" class="text-xs font-medium text-stone-soft">Simulation duration (Minutes)</label>
			<input
				id="simulation-duration"
				type="number"
				min="1"
				max={maxSimulationDuration}
				step="1"
				placeholder="Leave empty for unlimited"
				value={simulationDurationMinutes ?? ''}
				oninput={(event) => {
					revealErrors()
					simulationDurationMinutes = parseIntOrNull(event.currentTarget.value)
				}}
				class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
			/>
			{#if errors.simulationDuration}
				<p class="text-xs font-medium text-brand">{errors.simulationDuration}</p>
			{/if}
		</div>

		<div class="flex flex-col gap-1.5">
			<label for="access-code" class="text-xs font-medium text-stone-soft">Access code</label>
			<input
				id="access-code"
				type="text"
				required
				placeholder="Enter access code"
				bind:value={accessCode}
				oninput={revealErrors}
				class="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
			/>
			{#if errors.accessCode}
				<p class="text-xs font-medium text-brand">{errors.accessCode}</p>
			{/if}
		</div>

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
					{#if collaboratorAdminIds.length > 0}
						<span class="rounded-full bg-brand-tint px-2 py-0.5 text-xs font-semibold text-brand">
							{collaboratorAdminIds.length} selected
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
											checked={collaboratorAdminIds.includes(admin._id)}
											onchange={(event) => {
												const checked = event.currentTarget.checked
												collaboratorAdminIds = checked
													? [...collaboratorAdminIds, admin._id]
													: collaboratorAdminIds.filter((id) => id !== admin._id)
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
