<script lang="ts">
import { useQuery } from "convex-svelte";
import { goto } from "$app/navigation";
import { api } from "../../../../convex/_generated/api.js";

// Re-subscribes to the same query admin/+layout.svelte already resolved (Convex dedupes
// identical query+arg subscriptions, so this is free) instead of reading a session-stored
// role -- see admin/admins/+page.svelte's own identical comment for why that's the right
// call: a plain sessionStorage-backed copy is one tick behind this query's own side effect,
// and is unreliable on a cold load/reload of this route directly.
const viewer = useQuery(api.api.admins.viewer, {});
const isSuperAdmin = $derived(viewer.data?.role === "super");
</script>

<div class="relative min-h-screen overflow-hidden bg-parchment px-6 py-10">
	<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>
	<img
		src="/Chevron.webp"
		alt=""
		aria-hidden="true"
		class="pointer-events-none absolute -bottom-32 -right-32 z-0 w-[34rem] max-w-none select-none opacity-[0.14]"
	/>

	{#if isSuperAdmin}
		<button
			type="button"
			onclick={() => goto('/admin/admins')}
			class="fixed bottom-6 right-6 z-20 rounded-full border border-line bg-white px-6 py-3 text-sm font-semibold text-brand shadow-soft transition hover:border-brand hover:bg-brand-tint sm:bottom-auto sm:right-20 sm:top-12"
		>
			Manage admins
		</button>
	{/if}

	<div class="relative z-10 mx-auto flex min-h-[80vh] max-w-5xl flex-col justify-center">
		<div class="max-w-2xl">
			<div class="flex items-center gap-3">
				<span class="h-px w-8 bg-line"></span>
				<p class="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
					Admin Panel
				</p>
			</div>
			<h1 class="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
				Choose what you want to work on
			</h1>
			<p class="mt-4 max-w-xl text-sm leading-6 text-stone">
				Create a new simulation case from scratch or open an existing case for editing.
			</p>
		</div>

		<div class="mt-12 grid gap-6 md:grid-cols-2">
			<button
				type="button"
				onclick={() => goto('/admin/new')}
				class="group rounded-3xl border border-line bg-white p-8 text-left shadow-soft transition hover:-translate-y-1 hover:border-brand hover:shadow-premium"
			>
				<p class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-brand">
					Option 1
				</p>
				<h2 class="mt-4 font-display text-2xl font-semibold text-ink">Create New Case</h2>
				<p class="mt-3 text-sm leading-6 text-stone">
					Start a fresh case setup, define personas, referral logic, and upload files.
				</p>
				<div
					class="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-stone transition group-hover:gap-2.5 group-hover:text-brand"
				>
					Open case builder
					<span aria-hidden="true">&rarr;</span>
				</div>
			</button>

			<button
				type="button"
				onclick={() => goto('/admin/edit')}
				class="group rounded-3xl border border-line bg-cream p-8 text-left shadow-soft transition hover:-translate-y-1 hover:border-brand hover:shadow-premium"
			>
				<p class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
					Option 2
				</p>
				<h2 class="mt-4 font-display text-2xl font-semibold text-ink">Edit Existing Case</h2>
				<p class="mt-3 text-sm leading-6 text-stone">
					Load an existing case and update its setup, personas, or supporting materials.
				</p>
				<div
					class="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-stone transition group-hover:gap-2.5 group-hover:text-brand"
				>
					Open case list
					<span aria-hidden="true">&rarr;</span>
				</div>
			</button>
		</div>
	</div>
</div>
