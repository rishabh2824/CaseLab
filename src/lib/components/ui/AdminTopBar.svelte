<script lang="ts">
import House from "@lucide/svelte/icons/house";
import LogOut from "@lucide/svelte/icons/log-out";
import { authClient } from "#lib/auth-client.js";
import { goto } from "$app/navigation";
import { page } from "$app/state";

// Navigates to the landing page, then signs out. If the page has unsaved changes the navigation is
// held behind its dialog, so the sign-out only happens once the admin actually leaves.
async function signOutAdmin(): Promise<void> {
	await goto("/");
	if (page.url.pathname !== "/") return;
	authClient.signOut().catch(() => {});
}
</script>

<a
	href="/admin"
	aria-label="Go to admin home"
	class="fixed left-6 top-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-white text-ink-soft shadow-soft transition hover:border-brand hover:text-brand"
>
	<House class="h-5 w-5" aria-hidden="true" />
</a>

<button
	type="button"
	onclick={signOutAdmin}
	class="fixed bottom-6 left-6 z-40 flex items-center gap-2 rounded-xl border border-line bg-white px-5 py-3 text-sm font-semibold text-stone shadow-soft transition hover:border-ink hover:text-ink"
>
	<LogOut class="h-4 w-4" aria-hidden="true" />
	Sign out
</button>
