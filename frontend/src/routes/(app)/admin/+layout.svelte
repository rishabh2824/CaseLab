<script lang="ts">
import type { Snippet } from "svelte";
import AdminTopBar from "$lib/components/AdminTopBar.svelte";

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<AdminTopBar />
{@render children()}
