<script lang="ts">
import { getConvexClient } from "convex-svelte";
import { onMount, untrack } from "svelte";
import { toast } from "svelte-sonner";
import SimulationClock from "$lib/components/SimulationClock.svelte";
import { MAX_MESSAGE_WORDS } from "$lib/constants.js";
import { downloadBlob } from "$lib/download.js";
import { countWords, getPersonaInitials } from "$lib/format.js";
import { session } from "$lib/session.svelte.js";
import type { ExportRunOut } from "$lib/student/run.svelte.js";
import { createRunStore, exportRunRef } from "$lib/student/run.svelte.js";

const run = createRunStore();

onMount(() => {
	run.init();
});

let inputValue = $state("");
let isExporting = $state(false);
let chatInputEl = $state<HTMLTextAreaElement | null>(null);
let messagesEndEl = $state<HTMLDivElement | null>(null);

const wordCount = $derived(countWords(inputValue));
const overWordLimit = $derived(wordCount > MAX_MESSAGE_WORDS);
const activeMessages = $derived(run.activeMessages);

$effect(() => {
	if (run.activeContactId && run.activePersonaAvailable && !run.isSending) {
		const el = chatInputEl;
		requestAnimationFrame(() => el?.focus());
	}
});

let scrollScheduled = false;
let lastScrollKey = "";
$effect(() => {
	if (!run.activeContactId) return;
	const key = `${run.activeContactId}:${activeMessages.length}`;
	const changed = untrack(() => {
		if (key === lastScrollKey) return false;
		lastScrollKey = key;
		return true;
	});
	if (!changed || scrollScheduled) return;
	scrollScheduled = true;
	requestAnimationFrame(() => {
		scrollScheduled = false;
		messagesEndEl?.scrollIntoView({ block: "end" });
	});
});

function handleSend(): void {
	if (overWordLimit) return;
	if (run.sendMessage(inputValue)) inputValue = "";
}

function preloadPdfModule(): void {
	import("$lib/student/pdf.js").catch(() => {});
}

async function handleExportPdf(): Promise<void> {
	if (!session.runId || isExporting) return;
	isExporting = true;
	try {
		const data = (await getConvexClient().query(exportRunRef, {
			runId: session.runId,
		})) as ExportRunOut;
		const { buildChatPdfBlob } = await import("$lib/student/pdf.js");
		const blob = buildChatPdfBlob(data.personas ?? [], run.notes);
		downloadBlob(blob, "chats.pdf");
	} catch (err) {
		console.error(err);
		toast("Unable to export PDF. Please try again.");
	} finally {
		isExporting = false;
	}
}
</script>

<div class="min-h-screen bg-parchment">
	<header class="relative border-b border-line bg-white">
		<div class="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true"></div>
		<div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-2 py-3.5">
			<div class="flex items-center gap-4">
				<img src="/ModifiedWSB.webp" alt="Wisconsin School of Business" class="h-10 w-auto" />
				<span class="hidden h-9 w-px bg-line sm:block" aria-hidden="true"></span>
				<div>
					<h1 class="font-display text-base font-semibold tracking-tight text-ink">Wisconsin Case Lab</h1>
					<p class="text-xs text-stone-soft">{run.caseData?.case_name ?? 'Loading case…'}</p>
				</div>
			</div>
			<button
				type="button"
				disabled={!session.runId || isExporting}
				onclick={handleExportPdf}
				onpointerenter={preloadPdfModule}
				onfocus={preloadPdfModule}
				class="inline-flex items-center rounded-full border border-line bg-white px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
			>
				{isExporting ? 'Exporting…' : 'Export PDF'}
			</button>
		</div>
	</header>

	<!--
		run.loadError carries any live-subscription failure that ISN'T an expiry (expiry is
		handled by auto-restarting the run). Without this banner the store set the field and
		nothing ever read it, so a genuine backend error mid-simulation left the student looking
		at a silently frozen screen with no indication anything had gone wrong.
	-->
	{#if run.loadError}
		<div class="mx-auto max-w-7xl px-6 pt-4">
			<p role="alert" class="rounded-2xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
				{run.loadError}
			</p>
		</div>
	{/if}

	<main class="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[240px_minmax(0,1fr)_340px]">
		<aside class="space-y-6">
			<div>
				<h2 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
					People &amp; Contacts
				</h2>
				<div class="mt-3 space-y-2">
					{#each run.contacts as contact (contact.id)}
						<button
							type="button"
							disabled={!contact.available}
							onclick={() => contact.available && run.selectContact(contact.id)}
							class="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition {contact.id ===
							run.activeContactId
								? 'border-brand bg-white shadow-soft'
								: 'border-line bg-white/70 hover:border-stone-soft hover:bg-white'}"
						>
							{#if contact.profile_photo?.url}
								<img
									src={contact.profile_photo.url}
									alt="{contact.name} profile"
									class="h-9 w-9 rounded-full object-cover"
								/>
							{:else}
								<div
									class="grid h-9 w-9 place-items-center rounded-full text-xs font-semibold {contact.id ===
									run.activeContactId
										? 'bg-brand text-white'
										: 'bg-line-soft text-stone'}"
								>
									{getPersonaInitials(contact.name)}
								</div>
							{/if}
							<div class="flex-1">
								<p class="font-semibold text-ink">{contact.name || 'Unnamed'}</p>
								<p class="text-xs text-stone">{contact.role || 'Role'}</p>
								<p class="text-[11px] font-medium {contact.available ? 'text-success' : 'text-stone-soft'}">
									{contact.available
										? 'Available'
										: contact.available_in
											? `Available in ${contact.available_in} min`
											: 'Unavailable'}
								</p>
								{#if typeof contact.availability_duration === 'number'}
									<p class="text-[11px] text-stone-soft">Available for {contact.availability_duration} min</p>
								{/if}
								{#if typeof contact.expires_in === 'number' && contact.expires_in > 0}
									<p class="text-[11px] text-stone-soft">Expires in {contact.expires_in} min</p>
								{/if}
								{#if contact.chat_ended}
									<p class="text-[11px] text-brand">Conversation ended</p>
								{/if}
								{#if contact.is_referred}
									<p class="text-[11px] text-stone-soft">Referred contact</p>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			</div>

			<div>
				<h2 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">Shared files</h2>
				<div class="mt-3 space-y-2 rounded-xl border border-line bg-white p-3 shadow-soft">
					{#if run.sharedFiles.length === 0}
						<p class="text-xs text-stone-soft">No shared files yet.</p>
					{:else}
						{#each run.sharedFiles as file (file.file_id)}
							<div>
								<a
									class="text-sm font-semibold text-ink underline decoration-ink/30 underline-offset-2 transition hover:decoration-ink"
									href={file.url}
									target="_blank"
									rel="noreferrer"
								>
									{file.file_name}
								</a>
							</div>
						{/each}
					{/if}
				</div>
			</div>
		</aside>

		<section class="rounded-2xl border border-line bg-white p-6 shadow-soft">
			<div class="flex items-start justify-between">
				<div>
					<p class="font-display text-lg font-semibold tracking-tight text-ink">
						{run.activeContact?.name ?? 'Select a contact'}
					</p>
					<p class="text-sm text-stone">{run.activeContact?.role ?? ''}</p>
				</div>
				{#if run.activeContact?.chat_ended}
					<span class="inline-flex items-center gap-2 rounded-full bg-brand-tint px-3 py-1 text-xs font-medium text-brand">
						<span class="h-2 w-2 rounded-full bg-brand"></span>
						Conversation ended
					</span>
				{:else}
					<span
						class="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success"
					>
						<span class="h-2 w-2 rounded-full bg-success"></span>
						Available
					</span>
				{/if}
			</div>

			{#if run.activeContact?.chat_ended}
				<div class="mt-4 rounded-xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
					This persona has ended the conversation for this chat.
				</div>
			{/if}

			<div
				class="mt-5 max-h-[55vh] min-h-72 overflow-y-auto rounded-2xl border border-dashed border-line bg-cream/40 p-6 text-center text-sm text-stone-soft"
			>
				{#if activeMessages.length === 0 && !run.streamingPreview}
					Chat history is empty.
				{:else}
					<div class="space-y-3 text-left">
						{#each activeMessages as msg, index (index)}
							<div
								class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm {msg.role === 'user'
									? 'ml-auto bg-brand-tint text-ink-soft'
									: 'mr-auto border border-line bg-white text-stone'}"
							>
								{msg.content}
							</div>
						{/each}
						{#if run.streamingPreview}
							<div
								class="mr-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-line bg-white px-4 py-3 text-sm text-stone"
							>
								{run.streamingPreview}
							</div>
						{/if}
						<div bind:this={messagesEndEl}></div>
					</div>
				{/if}
			</div>

			<div class="mt-6 flex items-end gap-3 border-t border-line pt-4">
				<div class="flex-1">
					<textarea
						bind:this={chatInputEl}
						placeholder={run.activeContact?.chat_ended ? 'This conversation has ended.' : 'Type your message...'}
						disabled={!run.activePersonaAvailable || run.isSending}
						class="w-full resize-none rounded-xl border px-4 py-3 text-sm transition focus:outline-none focus:ring-4 {overWordLimit
							? 'border-brand focus:border-brand focus:ring-brand/12'
							: 'border-line focus:border-brand focus:ring-brand/12'} {run.activePersonaAvailable
							? 'bg-white text-ink-soft'
							: 'bg-cream text-stone-soft'}"
						rows="2"
						bind:value={inputValue}
						onkeydown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey) {
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
					disabled={!run.activePersonaAvailable || run.isSending || !inputValue.trim() || overWordLimit}
					onmousedown={(event) => event.preventDefault()}
					onclick={handleSend}
					class="rounded-xl px-5 py-3 text-sm font-semibold shadow-sm transition {!run.activePersonaAvailable ||
					run.isSending ||
					!inputValue.trim() ||
					overWordLimit
						? 'cursor-not-allowed bg-muted text-muted-foreground'
						: 'bg-brand text-white hover:brightness-95'}"
				>
					{#if run.isSending}
						<span class="typing-dots" aria-label="Typing"><span></span><span></span><span></span></span>
					{:else}
						Send
					{/if}
				</button>
			</div>
		</section>

		<aside class="space-y-4">
			<div class="rounded-2xl border border-line bg-white p-4 shadow-soft">
				<h3 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">Case Brief</h3>
				<p class="mt-2 text-sm leading-relaxed text-stone">{run.caseData?.brief ?? 'Loading brief...'}</p>
			</div>

			<SimulationClock startTime={session.startTime} totalDurationSeconds={run.totalDurationSeconds} />

			<div class="rounded-2xl border border-line bg-white p-4 shadow-soft">
				<h3 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">Your Notes</h3>
				<textarea
					class="mt-3 h-40 w-full resize-none rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
					placeholder="Write your notes here..."
					value={run.notes}
					oninput={(event) => run.setNotes(event.currentTarget.value)}
					onblur={() => run.flushNotes()}
				></textarea>
			</div>
		</aside>
	</main>

	<button
		type="button"
		onclick={() => run.endSimulation()}
		class="fixed bottom-6 left-6 rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-ink-soft"
	>
		End simulation
	</button>
</div>
