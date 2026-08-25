<script lang="ts">
import {
	createSvelteAuthClient,
	useAuth,
} from "@mmailaender/convex-better-auth-svelte/svelte";
import { makeFunctionReference } from "convex/server";
import { getConvexClient, useQuery } from "convex-svelte";
import type { Snippet } from "svelte";
import { browser } from "$app/environment";
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

// Google's redirect lands back here as /admin?ott=... -- the cross-domain one-time-token
// exchange that turns that into a real session (createSvelteAuthClient's internal
// handleOneTimeToken, run from its own onMount) takes two network round trips and runs
// independently of authClient.useSession(), which settles first and reports "not
// authenticated" before the exchange has even started. Without this guard the effect below
// reads that transient false and redirects back to Google mid-exchange, cancelling it --
// this is what made sign-in occasionally loop. Held open until either auth confirms
// (isAuthenticated flips true, handled by the effect's own check below) or this fixed
// window elapses -- generous enough for a slow network without delaying the plain
// unauthenticated case at all (that URL never carries "ott", so this starts false).
const OTT_EXCHANGE_GRACE_MS = 4000;
const hasOttParam =
	browser && new URLSearchParams(window.location.search).has("ott");
let awaitingOttExchange = $state(hasOttParam);
if (hasOttParam) {
	setTimeout(() => {
		awaitingOttExchange = false;
	}, OTT_EXCHANGE_GRACE_MS);
}

// Set by auth.ts's databaseHooks.user.create.before via errorCallbackURL below when a
// non-admin Google account signs in -- that rejection happens inside the OAuth callback,
// before any session/user row exists, so there's no `viewer` query to ever go null for it
// (unlike the removed-admin case the "Not authorized." branch further down handles).
// Read once at mount, not reactively -- every sign-in attempt (this one or a retry) is a
// full-page round trip through Google, so this component is always freshly mounted for
// whichever outcome the URL now encodes.
const authErrorParam = browser
	? new URLSearchParams(window.location.search).get("error")
	: null;

let signInError = $state("");

// This layout is the only way to reach anything admin-related, so completing the "Admin
// Login" gesture with the actual Google sign-in call here -- rather than requiring a
// second click on some intermediate page -- is what keeps sign-in a single click end to
// end.
let signInTriggered = false;
function startGoogleSignIn(): void {
	signInTriggered = true;
	signInError = "";
	authClient.signIn
		.social({
			provider: "google",
			callbackURL: "/admin",
			errorCallbackURL: "/admin?error=unauthorized",
		})
		.catch((err) => {
			signInError =
				err instanceof Error ? err.message : "Sign-in failed. Try again.";
		});
}

$effect(() => {
	if (
		auth.isLoading ||
		signInTriggered ||
		auth.isAuthenticated ||
		awaitingOttExchange ||
		authErrorParam === "unauthorized"
	) {
		return;
	}
	startGoogleSignIn();
});

function retrySignIn(): void {
	signInTriggered = false;
	startGoogleSignIn();
}

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

{#if authErrorParam === "unauthorized"}
	<div class="flex h-screen flex-col items-center justify-center gap-3">
		<p class="text-sm font-medium text-brand">Your account is not authorized.</p>
		<a href="/" class="text-sm underline">Back to the landing page</a>
	</div>
{:else if signInError}
	<div class="flex h-screen flex-col items-center justify-center gap-3">
		<p class="text-sm font-medium text-brand">{signInError}</p>
		<button type="button" onclick={retrySignIn} class="text-sm underline">
			Try again
		</button>
	</div>
{:else if auth.isLoading || viewer.isLoading || !auth.isAuthenticated}
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
