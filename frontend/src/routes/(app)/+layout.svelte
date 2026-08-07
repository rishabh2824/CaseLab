<script lang="ts">
import type { Snippet } from "svelte";
import { Toaster } from "svelte-sonner";

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<Toaster position="top-left" />
{@render children()}
