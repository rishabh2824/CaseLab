<script lang="ts">
import "../app.css";
import type { Snippet } from "svelte";

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<svelte:head><link rel="icon" href="/uwlogo.svg" /></svelte:head>
<main>{@render children()}</main>
