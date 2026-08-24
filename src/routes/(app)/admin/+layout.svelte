<script lang="ts">
import {
	setupConvexAuth,
	useAuth as useAuthProvider,
} from "@mmailaender/convex-auth-svelte/svelte";
import { makeFunctionReference } from "convex/server";
import { setupAuth, useAuth, useQuery } from "convex-svelte";
import type { Snippet } from "svelte";
import { goto } from "$app/navigation";
import AdminTopBar from "$lib/components/AdminTopBar.svelte";
import { resolveConvexUrl } from "$lib/convexUrl.js";
import { session } from "$lib/session.svelte.js";

type Props = { children: Snippet };

let { children }: Props = $props();

// Restores the Convex Auth session (JWT/refresh token) that AdminAuth.svelte stored in
// localStorage during sign-in on the landing page -- admin pages (e.g. admins/+page.svelte)
// need an authenticated Convex client to query/mutate through api/admins.ts. Scoped to this
// layout, not the root one, so students on "/" and "/student" still never load any of this.
// Also where a same-tab OAuth code exchange completes now that sign-in redirects straight
// here (see AdminAuth.svelte's handleSignIn) -- setupConvexAuth's internal code-in-URL
// handling runs on any page that calls it, not just AdminAuth.svelte.
setupConvexAuth({ convexUrl: resolveConvexUrl() });

const viewerRef = makeFunctionReference<"query">("api/admins:viewer");

// Captured before setupAuth() below overwrites convex-auth-svelte's own "$$_convexAuth"
// context entry with convex-svelte's pared-down replacement (both libraries use the same
// context key) -- AdminTopBar needs `signOut` and receives it as a prop instead of calling
// convex-auth-svelte's own useAuth(), which after this point would read the wrong shape.
const authProvider = useAuthProvider();

// setupConvexAuth() above wires the Convex client to the token this returns, but only
// once, at setup time. setupAuth() re-applies it reactively -- this is what makes signing
// out actually drop the Convex client's auth instead of just clearing localStorage: without
// it, a JWT issued before sign-out stays valid on the socket for up to its full lifetime,
// and the `viewer` query below would keep answering as the signed-out admin.
setupAuth(() => authProvider);
const auth = useAuth();
const viewer = useQuery(viewerRef, {});

// convex-auth-svelte runs two independent effects on mount: one loads any existing
// token from storage, the other exchanges a same-tab OAuth `?code=` param (from
// Google's redirect, see AdminAuth.svelte's handleSignIn) for a fresh one. On a fresh
// OAuth return there's no token in storage yet -- only the code exchange, a real
// network round trip, is about to produce one -- so the storage-load effect finds
// nothing and reports "done loading, not authenticated" well before the exchange
// lands. `auth`/`viewer` are both live queries and self-correct once the exchange
// completes, but only if nothing acts on that transient reading first. So an
// "unauthenticated" result has to hold for a bit before it's trusted and redirected on.
const REDIRECT_GRACE_MS = 2000;
let unauthenticatedSince: number | null = null;
let settleTick = $state(0);

$effect(() => {
	void settleTick;
	if (auth.isLoading || viewer.isLoading) {
		unauthenticatedSince = null;
		return;
	}
	if (auth.isAuthenticated && viewer.data) {
		unauthenticatedSince = null;
		session.setAdmin({
			adminRole: viewer.data.role,
			adminEmail: viewer.data.email,
		});
		return;
	}
	const now = Date.now();
	if (unauthenticatedSince === null) unauthenticatedSince = now;
	const elapsed = now - unauthenticatedSince;
	if (elapsed < REDIRECT_GRACE_MS) {
		const timer = setTimeout(() => {
			settleTick++;
		}, REDIRECT_GRACE_MS - elapsed);
		return () => clearTimeout(timer);
	}
	session.clearAdmin();
	goto("/", { replaceState: true });
});
</script>

{#if auth.isLoading || viewer.isLoading || !auth.isAuthenticated || !viewer.data}
	<!-- Loading, or about to redirect via the effect above -- rendering nothing here
	     avoids a flash of the admin shell (or stale children) before the gate settles. -->
{:else}
	<AdminTopBar signOut={authProvider.signOut} />
	{@render children()}
{/if}
