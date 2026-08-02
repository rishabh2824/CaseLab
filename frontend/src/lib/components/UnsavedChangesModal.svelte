<script lang="ts">
import { AlertDialog } from "bits-ui";

type Props = {
	open: boolean;
	isSaving: boolean;
	errorMessage: string;
	onSave: () => void;
	onDiscard: () => void;
	onCancel: () => void;
};

let {
	open = $bindable(false),
	isSaving,
	errorMessage,
	onSave,
	onDiscard,
	onCancel,
}: Props = $props();
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Portal>
		<AlertDialog.Overlay
			class="fixed inset-0 z-50 bg-ink/40 data-[state=closed]:hidden"
		/>
		<AlertDialog.Content
			class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-white p-6 shadow-soft data-[state=closed]:hidden"
		>
			<AlertDialog.Title class="font-display text-lg font-semibold text-ink">
				You have unsaved changes
			</AlertDialog.Title>
			<AlertDialog.Description class="mt-2 text-sm leading-6 text-stone">
				This case has edits that haven't been saved yet. Save them before
				leaving, or discard them and continue.
			</AlertDialog.Description>
			{#if errorMessage}
				<p class="mt-3 text-sm font-medium text-brand">{errorMessage}</p>
			{/if}
			<div class="mt-6 flex flex-wrap justify-end gap-3">
				<AlertDialog.Cancel
					onclick={onCancel}
					disabled={isSaving}
					class="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60"
				>
					Cancel
				</AlertDialog.Cancel>
				<button
					type="button"
					onclick={onDiscard}
					disabled={isSaving}
					class="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60"
				>
					Discard changes
				</button>
				<AlertDialog.Action
					onclick={onSave}
					disabled={isSaving}
					class="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{isSaving ? "Saving…" : "Save changes"}
				</AlertDialog.Action>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
