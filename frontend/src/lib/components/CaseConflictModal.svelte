<script lang="ts">
import { AlertDialog } from "bits-ui";

type Props = {
	open: boolean;
	onReload: () => void;
	onKeepEditing: () => void;
};

let { open = $bindable(false), onReload, onKeepEditing }: Props = $props();
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
				This case was updated by someone else
			</AlertDialog.Title>
			<AlertDialog.Description class="mt-2 text-sm leading-6 text-stone">
				Someone else has saved changes to this case since you started editing. You can reload to see
				their changes (your in-progress edits will be lost), or keep editing and overwrite their changes
				when you save.
			</AlertDialog.Description>
			<div class="mt-6 flex flex-wrap justify-end gap-3">
				<AlertDialog.Cancel
					onclick={onKeepEditing}
					class="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-brand hover:text-brand"
				>
					Keep editing — I'll overwrite theirs
				</AlertDialog.Cancel>
				<AlertDialog.Action
					onclick={onReload}
					class="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95"
				>
					Reload and lose my changes
				</AlertDialog.Action>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
