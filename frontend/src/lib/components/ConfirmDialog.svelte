<script module lang="ts">
// Shared button styles, so callers don't each retype the same class strings.
// SECONDARY is for Cancel/"keep editing"-type actions; CONFIRM is for the
// primary action, including destructive ones — this app has no separate
// danger color (CaseConflictModal's data-losing "Reload" already uses the
// same brand-colored primary button), so destructive confirms follow suit.
export const SECONDARY_BUTTON_CLASS =
	"rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60";
export const CONFIRM_BUTTON_CLASS =
	"rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60";
</script>

<script lang="ts">
import { AlertDialog } from "bits-ui";
import type { Snippet } from "svelte";

// Shared Overlay/Content shell for every AlertDialog-based confirmation in the
// admin UI — UnsavedChangesModal, CaseConflictModal, and any destructive-action
// confirm (delete admin/case, overwrite-on-import) render through this instead
// of each hand-rolling the same fixed-position overlay/panel markup. Callers
// supply their own `actions` snippet (button count and labels vary: a plain
// destructive confirm is Cancel/Confirm, UnsavedChangesModal is
// Cancel/Discard/Save) — see SECONDARY_BUTTON_CLASS/CONFIRM_BUTTON_CLASS above
// for the shared button styles.
type Props = {
	open: boolean;
	title: string;
	description?: string;
	errorMessage?: string;
	actions: Snippet;
};

let { open = $bindable(false), title, description, errorMessage, actions }: Props = $props();
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
				{title}
			</AlertDialog.Title>
			{#if description}
				<AlertDialog.Description class="mt-2 text-sm leading-6 text-stone">
					{description}
				</AlertDialog.Description>
			{/if}
			{#if errorMessage}
				<p class="mt-3 text-sm font-medium text-brand">{errorMessage}</p>
			{/if}
			<div class="mt-6 flex flex-wrap justify-end gap-3">
				{@render actions()}
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
