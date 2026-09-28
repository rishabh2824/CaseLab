<script lang="ts">
import House from "@lucide/svelte/icons/house";
import LogOut from "@lucide/svelte/icons/log-out";
import { goto } from "$app/navigation";
import { authClient } from "$lib/auth-client.js";
import { unsavedGuard } from "$lib/unsavedGuard.svelte.js";
import UnsavedChangesModal from "./UnsavedChangesModal.svelte";

// Signs the admin out and navigates to the landing page.
async function signOutAdmin(): Promise<void> {
	authClient.signOut().catch(() => {});
	await goto("/");
}

// Goes to the admin home, first asking about any unsaved changes.
function handleHomeClick(): void {
	unsavedGuard.requestNavigation(() => goto("/admin"));
}

// Signs out, first asking about any unsaved changes.
function handleSignOutClick(): void {
	unsavedGuard.requestNavigation(() => signOutAdmin());
}
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
	bind:open={() => unsavedGuard.showModal, (isOpen) => { if (!isOpen) unsavedGuard.closeModal() }}
	isSaving={unsavedGuard.isSaving}
	errorMessage={unsavedGuard.saveError}
	onSave={() => unsavedGuard.saveAndContinue()}
	onDiscard={() => unsavedGuard.discard()}
/>
