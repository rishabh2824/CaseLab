<script lang="ts">
import { AlertDialog } from "bits-ui";
import ConfirmDialog, {
	CONFIRM_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
} from "./ConfirmDialog.svelte";

type Props = {
	open: boolean;
	onReload: () => void;
	onKeepEditing: () => void;
};

let { open = $bindable(false), onReload, onKeepEditing }: Props = $props();
</script>

<ConfirmDialog
	bind:open
	title="This case was updated by someone else"
	description="Someone else has saved changes to this case since you started editing. You can reload to see their changes (your in-progress edits will be lost), or keep editing and overwrite their changes when you save."
>
	{#snippet actions()}
		<AlertDialog.Cancel onclick={onKeepEditing} class={SECONDARY_BUTTON_CLASS}>
			Keep editing — I'll overwrite theirs
		</AlertDialog.Cancel>
		<AlertDialog.Action onclick={onReload} class={CONFIRM_BUTTON_CLASS}>
			Reload and lose my changes
		</AlertDialog.Action>
	{/snippet}
</ConfirmDialog>
