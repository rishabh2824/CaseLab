<script lang="ts">
import { onMount } from "svelte";
import { apiFetch } from "$lib/api/client.js";
import {
	getPersonaLabel,
	normalizePersona,
	normalizeReferral,
	referredWithParents,
	rootPersonas as rootPersonasOf,
} from "$lib/case/draft.js";
import type { Api } from "$lib/types.js";
import ReadOnlyField from "./ReadOnlyField.svelte";
import ReadOnlyPersonaCard from "./ReadOnlyPersonaCard.svelte";

let caseData = $state<Api<"DemoCaseDetail"> | null>(null);
let isLoading = $state(true);
let loadError = $state("");

onMount(async () => {
	try {
		const data = await apiFetch<Api<"DemoCaseResponse">>("/api/cases/demo");
		caseData = data.case;
	} catch (err) {
		loadError =
			(err instanceof Error && err.message) || "Failed to load the demo case.";
	} finally {
		isLoading = false;
	}
});

// normalizePersona/normalizeReferral are the same helpers CaseForm.svelte uses
// on live persona/referral data from the API — reused here so the demo view's
// persona graph (root personas + referred personas) matches the real editor
// exactly.
const personas = $derived(
	(caseData?.personas ?? []).map((persona) => normalizePersona(persona)),
);
const referrals = $derived(
	(caseData?.referrals ?? []).map((referral) => normalizeReferral(referral)),
);
const roots = $derived(caseData?.roots ?? []);
const rootPersonas = $derived(rootPersonasOf(personas, roots));
const referredPersonas = $derived(
	referredWithParents(personas, referrals, roots),
);
</script>

<div class="relative min-h-screen bg-parchment">
	<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>
	<div class="mx-auto max-w-4xl px-6 py-10">
		{#if isLoading}
			<p class="text-center text-sm text-stone">Loading demo case...</p>
		{:else if loadError}
			<div class="rounded-2xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
				{loadError}
			</div>
		{:else if caseData}
			<div class="rounded-2xl border border-line bg-white p-8 shadow-soft">
				<div class="text-center">
					<p class="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
						Demo Case &middot; Read Only
					</p>
					<h1 class="mt-1.5 font-display text-3xl font-semibold text-ink">
						{caseData.case_name}
					</h1>
				</div>

				<div
					class="mt-6 rounded-xl border border-line-soft bg-cream/60 px-4 py-3 text-sm leading-6 text-ink-soft"
				>
					This is a fully built-out example case, kept here so new admins can see what a
					complete case looks like.
				</div>

				<details class="mt-6 rounded-2xl border border-line bg-white" open>
					<summary
						class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink"
					>
						Case Information
					</summary>
					<div class="grid grid-cols-1 gap-4 border-t border-line-soft px-5 py-5 sm:grid-cols-2">
						<ReadOnlyField label="Access code" value={caseData.access_code} />
						<ReadOnlyField
							label="Simulation duration (minutes)"
							value={caseData.simulation_duration}
							placeholder="Unlimited"
						/>
						<div class="sm:col-span-2">
							<ReadOnlyField label="Initial brief" value={caseData.initial_brief} />
						</div>
						<div class="sm:col-span-2">
							<ReadOnlyField label="Case background" value={caseData.common_information} />
						</div>
					</div>
				</details>

				<details class="mt-4 rounded-2xl border border-line bg-white" open>
					<summary
						class="cursor-pointer select-none px-5 py-4 font-display text-lg font-semibold text-ink"
					>
						AI Personas
					</summary>
					<p class="border-t border-line-soft px-5 pt-4 text-xs text-stone">
						Each persona below plays one character in the simulation. An arrow (&larr;) means
						that persona only becomes available once the student is referred to them by the
						persona on the right.
					</p>
					<div class="flex flex-col gap-3 px-5 pb-5 pt-3">
						{#if personas.length === 0}
							<p class="text-sm text-stone">No personas in this case.</p>
						{/if}
						{#each rootPersonas as persona, index (persona.id)}
							<details class="rounded-xl border border-line-soft bg-cream/40">
								<summary
									class="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-ink"
								>
									{getPersonaLabel(persona, `Persona ${index + 1}`)}
								</summary>
								<div class="border-t border-line-soft px-4 py-4">
									<ReadOnlyPersonaCard {persona} {personas} {referrals} />
								</div>
							</details>
						{/each}
						{#each referredPersonas as item (item.persona.id)}
							<details class="rounded-xl border border-line-soft bg-cream/40">
								<summary
									class="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-ink"
								>
									{item.label} &larr; {item.parentLabel}
								</summary>
								<div class="border-t border-line-soft px-4 py-4">
									<ReadOnlyPersonaCard persona={item.persona} {personas} {referrals} />
								</div>
							</details>
						{/each}
					</div>
				</details>
			</div>
		{/if}
	</div>
</div>
