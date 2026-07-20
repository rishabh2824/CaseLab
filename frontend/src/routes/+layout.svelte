<script>
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href="/uwlogo.svg" /></svelte:head>
{@render children()}
