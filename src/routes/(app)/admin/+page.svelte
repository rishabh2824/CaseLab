<script lang="ts">
import { getViewerContext } from "#lib/adminViewer.js";
import PageHeader from "#lib/components/PageHeader.svelte";

const viewer = getViewerContext();
const isSuperAdmin = $derived(viewer.data?.role === "super");
</script>

<div class="px-6 py-10">
	<img
		src="/Chevron.webp"
		alt=""
		aria-hidden="true"
		class="pointer-events-none absolute -bottom-32 -right-32 z-0 w-[34rem] max-w-none select-none opacity-[0.14]"
	/>

	{#if isSuperAdmin}
		<a
			href="/admin/admins"
			class="fixed bottom-6 right-6 z-20 rounded-full border border-line bg-white px-6 py-3 text-sm font-semibold text-brand shadow-soft transition hover:border-brand hover:bg-brand-tint sm:bottom-auto sm:right-20 sm:top-12"
		>
			Manage admins
		</a>
	{/if}

	<div class="relative z-10 mx-auto flex min-h-[80vh] max-w-5xl flex-col justify-center">
		<PageHeader
			eyebrow="Admin Panel"
			title="Choose what you want to work on"
			description="Create a new simulation case from scratch or open an existing case for editing."
		/>

		<div class="mt-12 grid gap-6 md:grid-cols-2">
			<a
				href="/admin/new"
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
			</a>

			<a
				href="/admin/edit"
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
			</a>
		</div>
	</div>
</div>
