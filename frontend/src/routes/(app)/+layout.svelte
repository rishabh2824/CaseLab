<script lang="ts">
import type { Snippet } from "svelte";
import { Toaster } from "svelte-sonner";

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<svelte:head>
	<!-- Login-gated: no content for a logged-out crawler, and duplicating
		 the landing page's title/description here would just be noise. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<Toaster position="top-left" />
{@render children()}
