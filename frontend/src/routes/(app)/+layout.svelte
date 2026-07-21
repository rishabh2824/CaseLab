<script lang="ts">
	import { Toaster } from 'svelte-sonner'
	import type { Snippet } from 'svelte'

	type Props = { children: Snippet }

	let { children }: Props = $props()
</script>

<Toaster position="top-left" />
{@render children()}
