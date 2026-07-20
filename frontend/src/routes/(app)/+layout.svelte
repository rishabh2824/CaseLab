<script>
	import { Toaster } from 'svelte-sonner'

	let { children } = $props()
</script>

<Toaster position="top-left" />
{@render children()}
