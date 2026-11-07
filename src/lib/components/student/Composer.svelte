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

// How long the ring takes to reach 90% when the reply has no response delay.
const QUICK_FILL_MS = 4000;

// Starts the sending ring empty and fills it to 90% in the few seconds most replies take, then crawls to 97% so it never looks finished before the reply lands. A reply held back by a response delay instead fills evenly to 97% by the time it is due, resuming part-way if the page was reloaded.
function creep(
	sentAt: number | null,
	deliverAt: number | null,
): (ring: SVGCircleElement) => () => void {
	return (ring) => {
		const delayMs =
			sentAt !== null && deliverAt !== null ? deliverAt - sentAt : 0;
		if (deliverAt !== null && delayMs > QUICK_FILL_MS) {
			const remainingMs = Math.max(0, deliverAt - Date.now());
			const filled = Math.min(1, Math.max(0, 1 - remainingMs / delayMs));
			ring.style.transition = "none";
			ring.style.strokeDashoffset = String(100 - 97 * filled);
			ring.getBoundingClientRect();
			ring.style.transition = `stroke-dashoffset ${remainingMs}ms linear`;
			ring.style.strokeDashoffset = "3";
			return () => {};
		}
		ring.getBoundingClientRect();
		ring.style.strokeDashoffset = "10";
		const crawl = setTimeout(() => {
			ring.style.transitionDuration = "30000ms";
			ring.style.transitionTimingFunction = "linear";
			ring.style.strokeDashoffset = "3";
		}, QUICK_FILL_MS);
		return () => clearTimeout(crawl);
	};
}

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
			<svg viewBox="0 0 24 24" class="size-5 -rotate-90" fill="none" stroke="currentColor" stroke-width="3" role="status" aria-label="Sending">
				<circle cx="12" cy="12" r="9" stroke-opacity="0.25" />
				<circle
					{@attach creep(run.replySentAt, run.replyDeliverAt)}
					cx="12"
					cy="12"
					r="9"
					pathLength="100"
					stroke-dasharray="100"
					stroke-dashoffset="100"
					stroke-linecap="round"
					class="transition-[stroke-dashoffset] duration-[4000ms] ease-out"
				/>
			</svg>
		{:else}
			Send
		{/if}
	</button>
</div>
