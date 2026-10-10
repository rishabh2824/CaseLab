<script lang="ts">
import { AlertDialog } from "bits-ui";

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

const SECONDARY_CLASS =
	"rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60";
const CONFIRM_CLASS =
	"rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60";
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
				<AlertDialog.Cancel disabled={confirming} class={SECONDARY_CLASS}>
					Cancel
				</AlertDialog.Cancel>
				{#if secondaryLabel && onSecondary}
					<button type="button" onclick={onSecondary} disabled={confirming} class={SECONDARY_CLASS}>
						{secondaryLabel}
					</button>
				{/if}
				<AlertDialog.Action onclick={onConfirm} disabled={confirming} class={CONFIRM_CLASS}>
					{confirming ? pendingLabel : confirmLabel}
				</AlertDialog.Action>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
