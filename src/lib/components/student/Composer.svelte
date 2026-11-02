<script lang="ts">
import { tick } from "svelte";
import Button from "#lib/components/ui/Button.svelte";
import type { RunStore } from "#lib/student/run.svelte.js";
import { countWords, MAX_MESSAGE_WORDS } from "#shared/rules.js";

let { run }: { run: RunStore } = $props();

let inputValue = $state("");
let chatInputEl = $state<HTMLTextAreaElement | null>(null);

const wordCount = $derived(countWords(inputValue));
const overWordLimit = $derived(wordCount > MAX_MESSAGE_WORDS);
// Whether the box accepts typing: the contact is open and no reply is in flight.
const canType = $derived(run.activePersonaAvailable && !run.isSending);
const canSend = $derived(canType && inputValue.trim() !== "" && !overWordLimit);

// Focuses the composer whenever it becomes usable, once the DOM has enabled it.
$effect(() => {
	if (canType) tick().then(() => chatInputEl?.focus());
});

// Puts a message back in the box, ahead of anything typed since.
function restore(text: string): void {
	if (inputValue.includes(text)) return;
	inputValue = inputValue.trim() ? `${text}\n${inputValue}` : text;
}

// Sends the typed message unless it is over the word limit. The box clears at once and gets the message back if the server does not accept it.
async function handleSend(): Promise<void> {
	if (overWordLimit) return;
	const text = inputValue;
	inputValue = "";
	if (!(await run.sendMessage(text))) restore(text);
}
</script>

{#if run.failedMessage !== null}
	<div
		role="alert"
		class="mt-6 flex items-center justify-between gap-3 rounded-xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand"
	>
		<p>Something went wrong generating a reply to “{run.failedMessage}”.</p>
		<Button size="sm" onclick={() => restore(run.failedMessage ?? "")}>
			Put it back in the box
		</Button>
	</div>
{/if}

<div class="mt-6 flex items-end gap-3 border-t border-line pt-4">
	<div class="flex-1">
		<textarea
			bind:this={chatInputEl}
			aria-label="Message"
			placeholder={run.timeExpired
				? "Time's up — messaging is disabled."
				: run.activeContact?.chatEnded
					? 'This conversation has ended.'
					: run.activePersonaAvailable
						? 'Type your message...'
						: 'This contact is no longer available.'}
			disabled={!canType}
			class="w-full resize-none rounded-xl border px-4 py-3 text-sm transition focus:outline-none focus:ring-4 {overWordLimit
				? 'border-brand focus:border-brand focus:ring-brand/12'
				: 'border-line focus:border-brand focus:ring-brand/12'} {run.activePersonaAvailable
				? 'bg-white text-ink-soft'
				: 'bg-cream text-stone-soft'}"
			rows="2"
			bind:value={inputValue}
			onkeydown={(event) => {
				if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
					event.preventDefault()
					handleSend()
				}
			}}
		></textarea>
		<p class="mt-1 text-right text-xs {overWordLimit ? 'text-brand' : 'text-stone-soft'}">
			{wordCount}/{MAX_MESSAGE_WORDS} words
		</p>
	</div>
	<button
		type="button"
		disabled={!canSend}
		onmousedown={(event) => event.preventDefault()}
		onclick={handleSend}
		class="rounded-xl px-5 py-3 text-sm font-semibold shadow-sm transition {!canSend
			? 'cursor-not-allowed bg-line-soft text-stone'
			: 'bg-brand text-white hover:brightness-95'}"
	>
		{#if run.isSending}
			<span class="inline-flex items-center gap-1" role="status" aria-label="Typing"><span class="size-1.5 animate-bounce rounded-full bg-current "></span><span class="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]"></span><span class="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]"></span></span>
		{:else}
			Send
		{/if}
	</button>
</div>
