<script lang="ts">
import type { Snippet } from "svelte";
import { setupConvexAuth, useAuth as useAuthProvider } from "@mmailaender/convex-auth-svelte/svelte";
import { setupAuth, useAuth, useQuery } from "convex-svelte";
import { makeFunctionReference } from "convex/server";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { ADMIN_ROLE } from "$lib/constants.js";
import { session } from "$lib/session.svelte.js";

// Everything Convex/auth-related lives in this component instead of the root layout so
// it's only ever loaded (see the dynamic `import()` in +page.svelte) once an admin
// actually engages the login flow -- the vast majority of visitors are students who
// never touch it, and mounting it eagerly for everyone is also what caused sign-in to
// resolve silently from a stored token on a plain tab open, with no click involved.
type Props = {
	class?: string;
	children?: Snippet;
	// True only when this component was mounted by an explicit "Admin Login" click
	// (as opposed to the page loading with an in-flight Google OAuth `code` param in
	// the URL) -- see +page.svelte for why the two mount paths need to behave
	// differently here.
	autoSignIn?: boolean;
};

let { class: className = "", children, autoSignIn = false }: Props = $props();

// convex-auth-svelte installs its own `beforeunload` listener (inside setupConvexAuth
// below) that shows the browser's native "leave site?" prompt while it's mid-refresh of
// the auth token -- meant to protect against losing unsaved work, but it also fires for
// our OWN deliberate hard navigation to /admin once sign-in succeeds (see
// navigateToAdmin), since that's a real page unload too. Registering this listener here,
// before setupConvexAuth runs, makes it fire first (same-target listeners run in
// registration order); stopImmediatePropagation then prevents the library's listener
// from running at all for navigations we know are intentional, without having to guess
// or wait for its internal refresh state to settle.
let intentionalNavigation = false;
window.addEventListener("beforeunload", (event) => {
	if (intentionalNavigation) event.stopImmediatePropagation();
});

setupConvexAuth({ convexUrl: PUBLIC_CONVEX_URL });

const viewerRef = makeFunctionReference<"query">("api/admins:viewer");

// setupConvexAuth() above wires the Convex client to the token this returns, but only
// once, at setup time, with no way to be told later that a token arrived -- so a client
// created before sign-in completes (this component's whole reason for existing) never
// re-authenticates once it does. convex-svelte's own setupAuth() is built exactly for
// this: it reactively re-calls `client.setAuth` whenever the provider's auth state
// changes, and exposes the result (used below as `auth`) as an isLoading/isAuthenticated
// pair already debounced against the transient states its own doc comments call out --
// e.g. the exact "goto() right after signIn, before the effect catches up" case this
// component's own OAuth-return flow hits. `authProvider` still holds signIn/signOut,
// which setupAuth's pared-down return doesn't carry.
const authProvider = useAuthProvider();
setupAuth(() => authProvider);
const auth = useAuth();
const viewer = useQuery(viewerRef, {});

let error = $state("");
let isPending = $state(false);

async function handleSignIn(): Promise<void> {
	error = "";
	isPending = true;
	try {
		const result = await authProvider.signIn("google");
		if (result.redirect) {
			intentionalNavigation = true;
			window.location.href = result.redirect.toString();
		}
	} catch (err) {
		error = err instanceof Error ? err.message : "Sign-in failed. Try again.";
	} finally {
		isPending = false;
	}
}

async function handleSignOut(): Promise<void> {
	await authProvider.signOut();
}

// Once true, the template stops reacting to auth/viewer state entirely (see below) --
// Convex Auth's own reconnect/token-refresh dance keeps nudging that state for a bit
// after sign-in completes (observably so in Chrome; imperceptibly fast in Firefox), and
// none of it matters anymore once we've committed to leaving the page.
let redirecting = $state(false);

$effect(() => {
	if (redirecting || viewer.isLoading) return;
	if (viewer.data) {
		session.setAdmin({
			adminRole: viewer.data.role === "super" ? ADMIN_ROLE.SUPER : ADMIN_ROLE.ADMIN,
			adminEmail: viewer.data.email,
		});
		navigateToAdmin();
	} else if (!auth.isAuthenticated) {
		session.clearAdmin();
	}
});

async function navigateToAdmin(): Promise<void> {
	redirecting = true;
	intentionalNavigation = true;

	// Wait for convex-auth-svelte to finish stripping the `?code=` param it consumed
	// (it does so with a history replace, asynchronously, on the load Google redirects
	// back to). Navigating while that's still pending races it: a history replace
	// landing on top of an in-flight navigation cancels the navigation in Chrome, which
	// bounces back to "/" and remounts this component before the retry finally sticks.
	// Firefox happens to win the race, which is why it was only visible in Chrome.
	for (let i = 0; i < 100 && new URLSearchParams(window.location.search).has("code"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	// A hard navigation, not `goto()`. This fires right after hydrating from a full
	// browser navigation (Google's OAuth redirect landing back on "/"), and SvelteKit's
	// client router doing a same-tick dynamic import of /admin's chunk right then is
	// unreliable -- it intermittently fails (observed in both Firefox and Chrome,
	// Firefox surfacing it as a visible error page) and falls back to SvelteKit's own
	// stale-chunk hard-reload recovery anyway. Since /admin (ssr=false) always renders
	// correctly from a real page load, going there directly sidesteps the race instead
	// of relying on that fallback. `replace`, not `href`, so Back from the admin panel
	// doesn't land on this mid-sign-in landing page.
	window.location.replace("/admin");
}

// This component only ever mounts as a direct result of a click (or of returning from
// the Google redirect that click caused), so completing that same gesture with the
// actual Google sign-in call here -- rather than requiring a second click on whatever
// this renders as -- is what makes "click once" true end to end.
let signInTriggered = false;
$effect(() => {
	if (autoSignIn && !signInTriggered && !auth.isLoading && !auth.isAuthenticated) {
		signInTriggered = true;
		handleSignIn();
	}
});
</script>

{#if redirecting}
	<button type="button" class={className} disabled>Redirecting…</button>
{:else if auth.isLoading || (auth.isAuthenticated && viewer.isLoading)}
	<!-- `viewer.isLoading`, not `!viewer.data`: an in-flight query has `data === undefined`,
	     which is indistinguishable from a resolved "no such admin" by data alone. Treating
	     the two the same is what made "Not authorized." flash on every sign-in before the
	     query had answered. -->
	<button type="button" class={className} disabled>Loading…</button>
{:else if auth.isAuthenticated}
	<div class="flex items-center gap-3">
		{#if viewer.data}
			<span class="text-xs font-medium">
				{viewer.data.email} ({viewer.data.role})
			</span>
		{:else}
			<span class="text-xs font-medium text-brand">Not authorized.</span>
		{/if}
		<button type="button" onclick={handleSignOut} class={className}>Sign Out</button>
	</div>
{:else}
	<div class="relative inline-block">
		<button type="button" onclick={handleSignIn} class={className} disabled={isPending}>
			{#if isPending}
				Signing in…
			{:else}
				{@render children?.()}
			{/if}
		</button>
		{#if error}
			<p class="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium text-brand shadow-md">
				{error}
			</p>
		{/if}
	</div>
{/if}
