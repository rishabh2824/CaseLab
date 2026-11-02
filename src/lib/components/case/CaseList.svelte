<script lang="ts" generics="T extends { _id: string; name: string; accessCode?: string }">
import type { Snippet } from "svelte";
import { getErrorMessage } from "#lib/errors.js";
import PageHeader from "../ui/PageHeader.svelte";

type Props = {
	eyebrow: string;
	title: string;
	description: string;
	query: {
		data: T[] | undefined;
		isLoading: boolean;
		error: Error | undefined;
	};
	href: (item: T) => string;
	// Sits in the card's top-right corner.
	overlay?: Snippet<[T]>;
	// Sits under the card.
	footer?: Snippet<[T]>;
};

let { eyebrow, title, description, query, href, overlay, footer }: Props =
	$props();
const items = $derived(query.data ?? []);
</script>

<div class="px-6 py-10">
	<div class="relative z-10 mx-auto max-w-4xl">
		<PageHeader {eyebrow} {title} {description} />

		<div class="mt-10 space-y-8">
			{#if query.isLoading}
				<div class="rounded-2xl border border-line bg-white p-5 text-sm text-stone">
					Loading cases...
				</div>
			{:else if query.error}
				<div class="rounded-2xl border border-brand/20 bg-brand-tint p-5 text-sm text-brand">
					{getErrorMessage(query.error, "Failed to load cases.")}
				</div>
			{:else if items.length === 0}
				<div class="rounded-2xl border border-line bg-white p-5 text-sm text-stone">
					No cases found.
				</div>
			{:else}
				{#each items as item (item._id)}
					<div>
						<div class="relative">
							<a
								href={href(item)}
								class="group block w-full rounded-2xl border border-line bg-white p-5 text-left shadow-soft transition hover:-translate-y-0.5 hover:border-brand hover:shadow-premium {overlay ? 'pr-20' : ''}"
							>
								<p class="font-display text-lg font-semibold text-ink transition group-hover:text-brand">
									{item.name}
								</p>
								{#if item.accessCode}
									<p class="mt-1 font-mono text-xs uppercase tracking-[0.18em] text-stone-soft">
										Access code: {item.accessCode}
									</p>
								{/if}
							</a>
							{#if overlay}
								<div class="absolute right-4 top-4">{@render overlay(item)}</div>
							{/if}
						</div>
						{@render footer?.(item)}
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>
