<script lang="ts">
import type { RunStore } from "#lib/student/run.svelte.js";
import Composer from "./Composer.svelte";

let { run }: { run: RunStore } = $props();

let messagesEl = $state<HTMLDivElement | null>(null);

const activeMessages = $derived(run.activeMessages);

// Changes only when the student switches contact or a message is added.
const scrollKey = $derived(`${run.activeContactId}:${activeMessages.length}`);
$effect(() => {
	void scrollKey;
	// Scroll the chat box itself; scrollIntoView would also move the page, which jumps on narrow screens where the chat sits above the composer.
	messagesEl?.scrollTo({ top: messagesEl.scrollHeight });
});
</script>

<section class="rounded-2xl border border-line bg-white p-6 shadow-soft">
	<div class="flex items-start justify-between">
		<div>
			<p class="font-display text-lg font-semibold tracking-tight text-ink">
				{run.activeContact?.name ?? 'Select a contact'}
			</p>
			<p class="text-sm text-stone">{run.activeContact?.role ?? ''}</p>
		</div>
		{#if run.activeContact?.chatEnded}
			<span class="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3 py-1 text-xs font-medium text-brand">
				<span class="h-2 w-2 rounded-full bg-brand"></span>
				Conversation ended
			</span>
		{:else if run.activePersonaAvailable}
			<span
				class="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success"
			>
				<span class="h-2 w-2 rounded-full bg-success"></span>
				Available
			</span>
		{:else}
			<span
				class="inline-flex items-center gap-2 rounded-full bg-line-soft px-3 py-1 text-xs font-medium text-stone"
			>
				<span class="h-2 w-2 rounded-full bg-stone-soft"></span>
				Unavailable
			</span>
		{/if}
	</div>

	{#if run.activeContact?.chatEnded}
		<div class="mt-4 rounded-xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
			This persona has ended the conversation for this chat.
		</div>
	{/if}

	<div
		bind:this={messagesEl}
		class="mt-5 max-h-[55vh] min-h-72 overflow-y-auto rounded-2xl border border-dashed border-line bg-cream/40 p-6 text-center text-sm text-stone-soft"
	>
		{#if activeMessages.length === 0}
			Chat history is empty.
		{:else}
			<div class="space-y-3 text-left" role="log" aria-live="polite" aria-label="Conversation">
				{#each activeMessages as msg, index (index)}
					<div
						class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm {msg.role === 'user'
							? 'ml-auto bg-brand-tint text-ink-soft'
							: 'mr-auto border border-line bg-white text-stone'}"
					>
						{msg.content}
					</div>
				{/each}
			</div>
		{/if}
	</div>


	<Composer {run} />
</section>
