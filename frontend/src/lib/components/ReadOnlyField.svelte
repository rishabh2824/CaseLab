<script lang="ts">
type Props = {
	label: string;
	value?: string | number | null;
	placeholder?: string;
};

let { label, value = null, placeholder = "Not set" }: Props = $props();

const hasValue = $derived(
	value !== null && value !== undefined && String(value).trim() !== "",
);
</script>

<div class="flex flex-col gap-1">
	<span class="text-xs font-medium text-stone-soft">{label}</span>
	{#if hasValue}
		<p class="whitespace-pre-wrap text-sm leading-6 text-ink-soft">{value}</p>
	{:else}
		<p class="text-sm italic text-stone-soft/70">{placeholder}</p>
	{/if}
</div>
