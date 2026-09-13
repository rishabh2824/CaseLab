<script module lang="ts">
// Shared button styles, so callers don't each retype the same class strings.
// SECONDARY is for Cancel/"keep editing"-type actions; CONFIRM is for the
// primary action, including destructive ones — this app has no separate
// danger color (DestructiveConfirmDialog's data-losing "Import" already uses
// the same brand-colored primary button), so destructive confirms follow suit.
export const SECONDARY_BUTTON_CLASS =
	"rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60";
export const CONFIRM_BUTTON_CLASS =
	"rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60";
</script>

<script lang="ts">
import { AlertDialog } from "bits-ui";
import type { Snippet } from "svelte";

// Shared Overlay/Content shell for every AlertDialog-based confirmation in the
// admin UI — UnsavedChangesModal and any destructive-action confirm (delete
// admin/case, overwrite-on-import) render through this instead of each
// hand-rolling the same fixed-position overlay/panel markup. Callers
// supply their own `actions` snippet (button count and labels vary: a plain
// destructive confirm is Cancel/Confirm, UnsavedChangesModal is
// Cancel/Discard/Save) — see SECONDARY_BUTTON_CLASS/CONFIRM_BUTTON_CLASS above
// for the shared button styles.
type Props = {
	open: boolean;
	title: string;
	description?: string;
	errorMessage?: string;
	// True while a confirm/save/discard action from this dialog is in flight. Every caller
	// already disables its own Cancel/Confirm buttons on this, but Escape bypasses both --
	// bits-ui's default AlertDialog.Content closes on Escape regardless of button state, which
	// let Escape dismiss the dialog mid-request (e.g. clearing UnsavedChangesModal's pending
	// navigation right as its save was about to complete, so the save then had nothing to
	// navigate to; or re-enabling a case/admin row's Delete button before its in-flight delete
	// had actually finished, so a second click raced the first). Defaults to false so a caller
	// that never sets it keeps bits-ui's normal Escape-to-close behavior.
	confirming?: boolean;
	actions: Snippet;
};

let {
	open = $bindable(false),
	title,
	description,
	errorMessage,
	confirming = false,
	actions,
}: Props = $props();
</script>

<AlertDialog.Root bind:open>
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
				<p class="mt-3 text-sm font-medium text-brand">{errorMessage}</p>
			{/if}
			<div class="mt-6 flex flex-wrap justify-end gap-3">
				{@render actions()}
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
