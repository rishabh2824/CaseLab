<script lang="ts">
import { AlertDialog } from "bits-ui";
import ConfirmDialog, {
	CONFIRM_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
} from "./ConfirmDialog.svelte";

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

<ConfirmDialog
	bind:open
	title="You have unsaved changes"
	description="This case has edits that haven't been saved yet. Save them before leaving, or discard them and continue."
	{errorMessage}
>
	{#snippet actions()}
		<AlertDialog.Cancel onclick={onCancel} disabled={isSaving} class={SECONDARY_BUTTON_CLASS}>
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
