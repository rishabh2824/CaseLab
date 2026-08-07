<script lang="ts">
import { AlertDialog } from "bits-ui";
import ConfirmDialog, {
	CONFIRM_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
} from "./ConfirmDialog.svelte";

// The plain Cancel/Confirm shape every window.confirm() replacement in the
// admin UI needs (delete admin, delete case, overwrite-on-import) — built on
// ConfirmDialog so those call sites don't each write out an `actions` snippet
// by hand for what is, every time, the same two buttons.
type Props = {
	open: boolean;
	title: string;
	description?: string;
	confirmLabel?: string;
	pendingLabel?: string;
	confirming?: boolean;
	onConfirm: () => void;
	onCancel?: () => void;
};

let {
	open = $bindable(false),
	title,
	description,
	confirmLabel = "Delete",
	pendingLabel = "Deleting…",
	confirming = false,
	onConfirm,
	onCancel,
}: Props = $props();
</script>

<ConfirmDialog bind:open {title} {description}>
	{#snippet actions()}
		<AlertDialog.Cancel onclick={onCancel} disabled={confirming} class={SECONDARY_BUTTON_CLASS}>
			Cancel
		</AlertDialog.Cancel>
		<AlertDialog.Action onclick={onConfirm} disabled={confirming} class={CONFIRM_BUTTON_CLASS}>
			{confirming ? pendingLabel : confirmLabel}
		</AlertDialog.Action>
	{/snippet}
</ConfirmDialog>
