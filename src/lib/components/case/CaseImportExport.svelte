<script lang="ts">
import { toast } from "svelte-sonner";
import type { CaseDraft } from "#lib/case/caseDraft.svelte.js";
import { buildHTMLForm, downloadForm } from "#lib/case/exportCase.js";
import { CaseImportError, parseHTMLForm } from "#lib/case/importCase.js";
import Button from "../ui/Button.svelte";
import ConfirmDialog from "../ui/ConfirmDialog.svelte";

type Props = { draft: CaseDraft; canImport: boolean };

let { draft, canImport }: Props = $props();

let pendingImportFile = $state<File | null>(null);
let fileInputEl = $state<HTMLInputElement | null>(null);

// Handles a chosen import file, asking for confirmation first if the form already has content.
function handleImportFile(
	event: Event & { currentTarget: EventTarget & HTMLInputElement },
): void {
	const file = event.currentTarget.files?.[0];
	event.currentTarget.value = "";
	if (!file) return;

	if (draft.hasContent) {
		pendingImportFile = file;
		return;
	}
	void performImport(file);
}

// Imports the file the user confirmed replacing the form with.
async function confirmImport(): Promise<void> {
	const file = pendingImportFile;
	pendingImportFile = null;
	if (file) await performImport(file);
}

// Parses an exported HTML form into the form fields, or shows a toast if the file is unusable.
async function performImport(file: File): Promise<void> {
	try {
		draft.applyImport(parseHTMLForm(await file.text()));
	} catch (err) {
		toast(
			err instanceof CaseImportError
				? err.message
				: "Failed to read that file. Make sure it’s an unmodified export from this app.",
		);
	}
}
</script>

<div class="absolute right-0 top-0 flex gap-2">
	{#if canImport}
		<input
			bind:this={fileInputEl}
			type="file"
			accept=".html,.htm,text/html"
			class="hidden"
			onchange={handleImportFile}
		/>
		<Button size="sm" onclick={() => fileInputEl?.click()}>Import template</Button>
	{/if}
	<Button size="sm" onclick={() => downloadForm(buildHTMLForm(draft.exportInput()))}>
		Export template
	</Button>
</div>

<ConfirmDialog
	open={pendingImportFile !== null}
	onClose={() => (pendingImportFile = null)}
	title="Replace everything in this form?"
	description="Import will replace everything currently in this form. This cannot be undone."
	confirmLabel="Import"
	pendingLabel="Importing…"
	onConfirm={confirmImport}
/>
