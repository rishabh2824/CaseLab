<script lang="ts">
import PageHeader from "#lib/components/PageHeader.svelte";
</script>

<div class="px-6 py-10">
	<img
		src="/Chevron.webp"
		alt=""
		aria-hidden="true"
		class="pointer-events-none absolute -bottom-32 -right-32 z-0 w-[34rem] max-w-none select-none opacity-[0.14]"
	/>
	<div class="relative z-10 mx-auto flex min-h-[80vh] max-w-5xl flex-col justify-center">
		<PageHeader
			eyebrow="Create Case"
			title="How do you want to begin?"
			description="Start with a blank case builder or reuse an existing case as the base for a new one."
		/>

		<div class="mt-12 grid gap-6 md:grid-cols-2">
			<a
				href="/admin/cases/new"
				class="group rounded-3xl border border-line bg-white p-8 text-left shadow-soft transition hover:-translate-y-1 hover:border-brand hover:shadow-premium"
			>
				<p class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-brand">
					Option 1
				</p>
				<h2 class="mt-4 font-display text-2xl font-semibold text-ink">Start From Scratch</h2>
				<p class="mt-3 text-sm leading-6 text-stone">
					Open the empty case form and build everything from the ground up.
				</p>
				<div
					class="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-stone transition group-hover:gap-2.5 group-hover:text-brand"
				>
					Open blank form
					<span aria-hidden="true">&rarr;</span>
				</div>
			</a>

			<a
				href="/admin/new/template"
				class="group rounded-3xl border border-line bg-cream p-8 text-left shadow-soft transition hover:-translate-y-1 hover:border-brand hover:shadow-premium"
			>
				<p class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-brand">
					Option 2
				</p>
				<h2 class="mt-4 font-display text-2xl font-semibold text-ink">
					Use Existing Case As Template
				</h2>
				<p class="mt-3 text-sm leading-6 text-stone">
					Choose an existing case and preload its details into a new-case form.
				</p>
				<div
					class="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-stone transition group-hover:gap-2.5 group-hover:text-brand"
				>
					Choose a case
					<span aria-hidden="true">&rarr;</span>
				</div>
			</a>
		</div>
	</div>
</div>
