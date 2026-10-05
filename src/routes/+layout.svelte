<script lang="ts">
import { setupConvex } from "convex-svelte";
import type { Snippet } from "svelte";
import "../app.css";
import { resolveConvexUrl } from "#lib/convexUrl.js";

type Props = { children: Snippet };

let { children }: Props = $props();

setupConvex(resolveConvexUrl(), {
	initialAuthTokenReuse: true,
});
</script>

<svelte:head><link rel="icon" href="/uwlogo.svg" /></svelte:head>
<main>{@render children()}</main>
