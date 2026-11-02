<script lang="ts">
import { AlertDialog } from "bits-ui";
import Button, { buttonClass } from "./Button.svelte";

type Props = {
	open: boolean;
	onClose: () => void;
	title: string;
	description?: string;
	errorMessage?: string;
	confirmLabel?: string;
	pendingLabel?: string;
	confirming?: boolean;
	onConfirm: () => void;
	secondaryLabel?: string;
	onSecondary?: () => void;
};

let {
	open,
	onClose,
	title,
	description,
	errorMessage,
	confirmLabel = "Delete",
	pendingLabel = "Deleting…",
	confirming = false,
	onConfirm,
	secondaryLabel,
	onSecondary,
}: Props = $props();
</script>

<AlertDialog.Root {open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
	<AlertDialog.Portal>
		<AlertDialog.Overlay
			class="fixed inset-0 z-50 bg-ink/40 data-[state=closed]:hidden"
		/>
		<AlertDialog.Content
			escapeKeydownBehavior={confirming ? "ignore" : "close"}
			class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-white p-6 shadow-soft data-[state=closed]:hidden"
		>
			<AlertDialog.Title class="font-display text-lg font-semibold text-ink">
				{title}
			</AlertDialog.Title>
			{#if description}
				<AlertDialog.Description class="mt-2 text-sm leading-6 text-stone">
					{description}
				</AlertDialog.Description>
			{/if}
			{#if errorMessage}
				<p role="alert" class="mt-3 text-sm font-medium text-brand">{errorMessage}</p>
			{/if}
			<div class="mt-6 flex flex-wrap justify-end gap-3">
				<AlertDialog.Cancel disabled={confirming} class={buttonClass()}>
					Cancel
				</AlertDialog.Cancel>
				{#if secondaryLabel && onSecondary}
					<Button onclick={onSecondary} disabled={confirming}>
						{secondaryLabel}
					</Button>
				{/if}
				<!-- Not AlertDialog.Action: it closes the dialog on click, before an async confirm can finish. -->
				<Button variant="primary" onclick={onConfirm} disabled={confirming}>
					{confirming ? pendingLabel : confirmLabel}
				</Button>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
