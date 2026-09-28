<script lang="ts">
import { AlertDialog } from "bits-ui";
import ConfirmDialog, {
	CONFIRM_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
} from "./ConfirmDialog.svelte";

type Props = {
	open: boolean;
	title: string;
	description?: string;
	confirmLabel?: string;
	pendingLabel?: string;
	confirming?: boolean;
	onConfirm: () => void;
};

let {
	open = $bindable(false),
	title,
	description,
	confirmLabel = "Delete",
	pendingLabel = "Deleting…",
	confirming = false,
	onConfirm,
}: Props = $props();
</script>

<ConfirmDialog bind:open {title} {description} {confirming}>
	{#snippet actions()}
		<AlertDialog.Cancel disabled={confirming} class={SECONDARY_BUTTON_CLASS}>
			Cancel
		</AlertDialog.Cancel>
		<AlertDialog.Action onclick={onConfirm} disabled={confirming} class={CONFIRM_BUTTON_CLASS}>
			{confirming ? pendingLabel : confirmLabel}
		</AlertDialog.Action>
	{/snippet}
</ConfirmDialog>
