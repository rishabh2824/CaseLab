<script lang="ts">
import { getConvexClient } from "convex-svelte";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import ChatPanel from "#lib/components/student/ChatPanel.svelte";
import ContactList from "#lib/components/student/ContactList.svelte";
import SidePanel from "#lib/components/student/SidePanel.svelte";
import { downloadBlob } from "#lib/download.js";
import { session } from "#lib/session.svelte.js";
import { createRunStore } from "#lib/student/run.svelte.js";

const run = createRunStore();

onMount(() => {
	run.init();
});

let isExporting = $state(false);

// Preloads the PDF module so exporting feels instant.
function preloadPdfModule(): void {
	import("#lib/student/pdf.js").catch(() => {});
}

// Fetches the run's export data and downloads it as a PDF along with the student's notes.
async function handleExportPdf(): Promise<void> {
	if (!session.runId || isExporting) return;
	isExporting = true;
	try {
		const data = await getConvexClient().query(api.runs.exportRun, {
			runId: session.runId as Id<"runs">,
		});
		const { buildChatPdfBlob } = await import("#lib/student/pdf.js");
		const blob = buildChatPdfBlob(data.personas, run.notes);
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
					<p class="text-xs text-stone-soft">{run.caseData?.name ?? 'Loading case…'}</p>
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

	{#if run.loadError}
		<div class="mx-auto max-w-7xl px-6 pt-4">
			<p role="alert" class="rounded-2xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
				{run.loadError}
			</p>
		</div>
	{/if}

	{#if run.timeExpired}
		<div class="mx-auto max-w-7xl px-6 pt-4">
			<p class="rounded-2xl border border-brand/20 bg-brand-tint px-4 py-3 text-sm text-brand">
				Your time is up. You can no longer send messages, but you can still review your conversations and export your transcript.
			</p>
		</div>
	{/if}

	<div class="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[240px_minmax(0,1fr)_340px]">
		<aside class="space-y-6">
			<ContactList
				contacts={run.contacts}
				activeContactId={run.activeContactId}
				onSelect={(contactId) => run.selectContact(contactId)}
			/>

			<div>
				<h2 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">Shared files</h2>
				<div class="mt-3 space-y-2 rounded-xl border border-line bg-white p-3 shadow-soft">
					{#if run.sharedFiles.length === 0}
						<p class="text-xs text-stone-soft">No shared files yet.</p>
					{:else}
						{#each run.sharedFiles as file (file.fileId)}
							<div>
								<a
									class="text-sm font-semibold text-ink underline decoration-ink/30 underline-offset-2 transition hover:decoration-ink"
									href={file.url}
									target="_blank"
									rel="noreferrer"
								>
									{file.fileName}
								</a>
							</div>
						{/each}
					{/if}
				</div>
			</div>
		</aside>

		<ChatPanel {run} />

		<SidePanel {run} />
	</div>

	<button
		type="button"
		onclick={() => run.endSimulation()}
		class="fixed bottom-6 left-6 rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-ink-soft"
	>
		End simulation
	</button>

	<div class="fixed bottom-6 right-6 flex gap-3">
		{#if run.caseData?.authors.length}
			<div class="group relative">
				<button
					type="button"
					class="rounded-xl border border-line bg-white px-4 py-3 text-sm font-semibold text-ink shadow-lg transition group-hover:bg-cream"
				>
					Authors
				</button>
				<div class="invisible absolute bottom-full right-0 pb-2 opacity-0 transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
					<ul aria-label="Authors" class="min-w-44 space-y-1 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink-soft shadow-lg">
						{#each run.caseData.authors as author, index (index)}
							<li>{author}</li>
						{/each}
					</ul>
				</div>
			</div>
		{/if}

		<div class="group relative">
			<button
				type="button"
				class="rounded-xl border border-line bg-white px-4 py-3 text-sm font-semibold text-ink shadow-lg transition group-hover:bg-cream"
			>
				Contact
			</button>
			<div class="invisible absolute bottom-full right-0 pb-2 opacity-0 transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
				<p class="whitespace-nowrap rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink-soft shadow-lg">
					<a href="mailto:jordan.tong@wisc.edu" class="underline decoration-ink/30 underline-offset-2 hover:decoration-ink">jordan.tong@wisc.edu</a>
				</p>
			</div>
		</div>
	</div>
</div>
