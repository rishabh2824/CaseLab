<script lang="ts">
import { AlertDialog } from "bits-ui";
import ConfirmDialog, {
	CONFIRM_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
} from "./ConfirmDialog.svelte";

// No onCancel prop: AlertDialog.Cancel already closes the dialog on its own (bits-ui's
// built-in behavior), and unsavedGuard.svelte.ts's caller-side bind:open setter already calls
// closeModal() the moment open flips to false -- a cancel handler here would just be a second
// way to trigger that same setter.
type Props = {
	open: boolean;
	isSaving: boolean;
	errorMessage: string;
	onSave: () => void;
	onDiscard: () => void;
};

let {
	open = $bindable(false),
	isSaving,
	errorMessage,
	onSave,
	onDiscard,
}: Props = $props();
</script>

<ConfirmDialog
	bind:open
	title="You have unsaved changes"
	description="This case has edits that haven't been saved yet. Save them before leaving, or discard them and continue."
	{errorMessage}
	confirming={isSaving}
>
	{#snippet actions()}
		<AlertDialog.Cancel disabled={isSaving} class={SECONDARY_BUTTON_CLASS}>
			Cancel
		</AlertDialog.Cancel>
		<button type="button" onclick={onDiscard} disabled={isSaving} class={SECONDARY_BUTTON_CLASS}>
			Discard changes
		</button>
		<AlertDialog.Action onclick={onSave} disabled={isSaving} class={CONFIRM_BUTTON_CLASS}>
			{isSaving ? "Saving…" : "Save changes"}
		</AlertDialog.Action>
	{/snippet}
</ConfirmDialog>
