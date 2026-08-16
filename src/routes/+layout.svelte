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
// visitor here at the root rather than behind a route-specific layout.
setupConvex(resolveConvexUrl());
</script>

<svelte:head><link rel="icon" href="/uwlogo.svg" /></svelte:head>
<main>{@render children()}</main>
