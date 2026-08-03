<script lang="ts">
import House from "@lucide/svelte/icons/house";
import LogOut from "@lucide/svelte/icons/log-out";
import { goto } from "$app/navigation";
import { signOutAdmin } from "$lib/auth.js";
import { useUnsavedGuard } from "$lib/unsavedGuard.svelte.js";
import UnsavedChangesModal from "./UnsavedChangesModal.svelte";

const unsavedGuard = useUnsavedGuard();

let showUnsavedModal = $state(false);
let isSaving = $state(false);
let saveError = $state("");
let pendingAction = $state<(() => void | Promise<void>) | null>(null);

// Any navigation triggered while a case has unsaved edits is routed through
// here so the admin gets a chance to save or discard first, no matter which
// admin page (and thus which action — home vs. sign out) triggered it.
function requestNavigation(action: () => void | Promise<void>): void {
	if (unsavedGuard.isDirty) {
		saveError = "";
		pendingAction = action;
		showUnsavedModal = true;
	} else {
		action();
	}
}

function handleHomeClick(): void {
	requestNavigation(() => goto("/admin"));
}

function handleSignOutClick(): void {
	requestNavigation(() => signOutAdmin());
}

function closeModal(): void {
	showUnsavedModal = false;
	pendingAction = null;
	saveError = "";
}

function handleCancel(): void {
	closeModal();
}

async function handleDiscard(): Promise<void> {
	const action = pendingAction;
	closeModal();
	unsavedGuard.unregister();
	if (action) await action();
}

async function handleSave(): Promise<void> {
	isSaving = true;
	saveError = "";
	try {
		const result = await unsavedGuard.save();
		if (!result.ok) {
			saveError = result.error;
			return;
		}
		const action = pendingAction;
		closeModal();
		if (action) await action();
	} finally {
		isSaving = false;
	}
}

// Dismissing the dialog via Escape/outside-click (not one of our buttons)
// still needs to clear pending state — otherwise a later reopen could reuse
// a stale action or error message.
$effect(() => {
	if (!showUnsavedModal) {
		pendingAction = null;
		saveError = "";
	}
});
</script>

<button
	type="button"
	onclick={handleHomeClick}
	aria-label="Go to admin home"
	class="fixed left-6 top-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-white text-ink-soft shadow-soft transition hover:border-brand hover:text-brand"
>
	<House class="h-5 w-5" aria-hidden="true" />
</button>

<button
	type="button"
	onclick={handleSignOutClick}
	class="fixed bottom-6 left-6 z-40 flex items-center gap-2 rounded-xl border border-line bg-white px-5 py-3 text-sm font-semibold text-stone shadow-soft transition hover:border-ink hover:text-ink"
>
	<LogOut class="h-4 w-4" aria-hidden="true" />
	Sign out
</button>

<UnsavedChangesModal
	bind:open={showUnsavedModal}
	{isSaving}
	errorMessage={saveError}
	onSave={handleSave}
	onDiscard={handleDiscard}
	onCancel={handleCancel}
/>
