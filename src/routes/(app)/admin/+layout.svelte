<script lang="ts">
import {
	createSvelteAuthClient,
	useAuth,
} from "@mmailaender/convex-better-auth-svelte/svelte";
import { makeFunctionReference } from "convex/server";
import { getConvexClient, useQuery } from "convex-svelte";
import type { Snippet } from "svelte";
import { goto } from "$app/navigation";
import { authClient } from "$lib/auth-client.js";
import AdminTopBar from "$lib/components/AdminTopBar.svelte";
import { session } from "$lib/session.svelte.js";

type Props = { children: Snippet };
let { children }: Props = $props();

// Reuses the root layout's existing Convex client (+layout.svelte's setupConvex) instead
// of opening a second connection -- the one place this needs to be called at all, since
// Better Auth's session is a single cookie-backed client singleton: unlike the old
// library, nothing here needs re-initializing per subtree (see AdminAuth.svelte's
// removal -- the landing page's "Admin Login" button is now a plain link to /admin).
createSvelteAuthClient({ authClient, convexClient: getConvexClient() });

// String-based reference (not a generated `api` import): the convex/ project lives at
// the repo root, outside this Vite project's root, so `_generated/api` doesn't resolve
// cleanly from here. Referenced from elsewhere in the frontend as "see admin/+layout.svelte
// for why".
const viewerRef = makeFunctionReference<"query">("api/admins:viewer");
const auth = useAuth();
const viewer = useQuery(viewerRef, {});

// This layout is the only way to reach anything admin-related, so completing the "Admin
// Login" gesture with the actual Google sign-in call here -- rather than requiring a
// second click on some intermediate page -- is what keeps sign-in a single click end to
// end.
let signInTriggered = false;
$effect(() => {
	if (auth.isLoading || signInTriggered || auth.isAuthenticated) return;
	signInTriggered = true;
	authClient.signIn.social({ provider: "google", callbackURL: "/admin" });
});

$effect(() => {
	if (auth.isLoading || viewer.isLoading) return;
	if (auth.isAuthenticated && viewer.data) {
		session.setAdmin({
			adminRole: viewer.data.role,
			adminEmail: viewer.data.email,
		});
	} else if (!auth.isAuthenticated) {
		session.clearAdmin();
	}
});

// See AdminTopBar.svelte's signOutAdmin for why this isn't awaited before navigating.
async function signOutNotAuthorized(): Promise<void> {
	authClient.signOut().catch(() => {});
	session.clearAdmin();
	await goto("/");
}
</script>

{#if auth.isLoading || viewer.isLoading || !auth.isAuthenticated}
	<!-- Loading, or the effect above is about to redirect to Google -- render nothing so
	     there's no flash of "Not authorized." before that redirect happens. -->
{:else if !viewer.data}
	<div class="flex h-screen flex-col items-center justify-center gap-3">
		<p class="text-sm font-medium text-brand">Not authorized.</p>
		<button type="button" onclick={signOutNotAuthorized} class="text-sm underline">
			Sign out
		</button>
	</div>
{:else}
	<AdminTopBar />
	{@render children()}
{/if}
