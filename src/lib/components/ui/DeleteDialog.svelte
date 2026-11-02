<script lang="ts" generics="T">
import { toast } from "svelte-sonner";
import { getErrorMessage } from "#lib/errors.js";
import ConfirmDialog from "./ConfirmDialog.svelte";

type Props = {
	// What is waiting to be deleted. The dialog is open while this is set, and clears it when it closes.
	item: T | null;
	title: (item: T) => string;
	description: string;
	// Toasted when onDelete throws and the server gave no message of its own.
	failureMessage: string;
	onDelete: (item: T) => Promise<unknown>;
};

let {
	item = $bindable(),
	title,
	description,
	failureMessage,
	onDelete,
}: Props = $props();

let isDeleting = $state(false);

// Deletes the pending item and closes the dialog, showing a toast if the request fails.
async function confirm(): Promise<void> {
	if (item === null) return;
	isDeleting = true;
	try {
		await onDelete(item);
		item = null;
	} catch (err) {
		toast(getErrorMessage(err, failureMessage));
	} finally {
		isDeleting = false;
	}
}
</script>

<ConfirmDialog
	open={item !== null}
	onClose={() => (item = null)}
	title={item === null ? "" : title(item)}
	{description}
	confirming={isDeleting}
	onConfirm={confirm}
/>
