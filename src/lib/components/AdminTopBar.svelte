<script lang="ts">
import House from "@lucide/svelte/icons/house";
import LogOut from "@lucide/svelte/icons/log-out";
import { goto } from "$app/navigation";
import { authClient } from "$lib/auth-client.js";
import { unsavedGuard } from "$lib/unsavedGuard.svelte.js";
import UnsavedChangesModal from "./UnsavedChangesModal.svelte";

async function signOutAdmin(): Promise<void> {
	// Not awaited: crossDomainClient clears the local session synchronously, before the
	// sign-out request is even sent (see its `init` hook) -- waiting on the network
	// round-trip here just risks stranding the admin on a blank /admin if that request is
	// slow or hangs, for no benefit (the local state is already correct by this point).
	authClient.signOut().catch(() => {});
	await goto("/");
}

// The unsaved-changes prompt's own open/isSaving/error state now lives on unsavedGuard itself
// (not here) -- see its own comment for why: CaseForm.svelte's navigation guards route through
// the exact same requestNavigation/discard/saveAndContinue, so there's one prompt shared by
// every navigation attempt instead of one AdminTopBar owns alone.
function handleHomeClick(): void {
	unsavedGuard.requestNavigation(() => goto("/admin"));
}

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
