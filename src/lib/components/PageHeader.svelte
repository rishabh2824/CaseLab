<script lang="ts">
type Props = {
	eyebrow: string;
	title: string;
	description?: string;
};

let { eyebrow, title, description }: Props = $props();
</script>

<div class="max-w-2xl">
	<div class="flex items-center gap-3">
		<span class="h-px w-8 bg-line"></span>
		<p class="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
			{eyebrow}
		</p>
	</div>
	<h1 class="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
		{title}
	</h1>
	{#if description}
		<p class="mt-4 max-w-xl text-sm leading-6 text-stone">{description}</p>
	{/if}
</div>
