<script lang="ts">
import { setupConvex } from "convex-svelte";
import type { Snippet } from "svelte";
import "../app.css";
import { resolveConvexUrl } from "$lib/convexUrl.js";

type Props = { children: Snippet };

let { children }: Props = $props();

// Plain (unauthenticated) Convex client, needed by the student access-code/simulation
// flow on "/" and "/student" -- unlike (app)/admin/+layout.svelte's setupConvexAuth,
// this pulls in no Google-auth machinery, so it's cheap enough to set up for every
// visitor here at the root rather than behind a route-specific layout. This is also the
// one client instance admin/+layout.svelte's setupConvexAuth reuses (context-based
// singleton lookup), so client-level options belong here, not there.
setupConvex(resolveConvexUrl(), {
	// Once the server confirms a cached token is still valid, reuse it instead of
	// immediately fetching a fresh one on top of that confirmation -- the default forces
	// a second Authenticate round trip (and a full refresh-token rotation) on every
	// authenticated page load, even when the existing token has plenty of life left. A
	// no-op for students, who never authenticate.
	initialAuthTokenReuse: true,
});
</script>

<svelte:head><link rel="icon" href="/uwlogo.svg" /></svelte:head>
<main>{@render children()}</main>
