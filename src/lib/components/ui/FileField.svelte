<script lang="ts">
import type { Snippet } from "svelte";
import type { FileRefPayload } from "#lib/types.js";
import FormField, { INPUT_CLASS } from "./FormField.svelte";

type Props = {
	label: string;
	help: string;
	id: string;
	// The chosen file, or the saved reference for one chosen earlier.
	value: File | FileRefPayload | null | undefined;
	onChange: (file: File | null) => void;
	// Names a saved file, such as "Existing photo".
	existingLabel: string;
	accept?: string;
	required?: boolean;
	error?: string;
	// The button's colour, for sitting on a cream or a white card.
	tone?: "cream" | "white";
	// Replaces the line that names the current file.
	status?: Snippet;
};

let {
	label,
	help,
	id,
	value,
	onChange,
	existingLabel,
	accept,
	required = false,
	error,
	tone = "cream",
	status,
}: Props = $props();

// Hands the chosen file over and resets the input, so choosing the same file again still registers.
function handleChange(
	event: Event & { currentTarget: EventTarget & HTMLInputElement },
): void {
	onChange(event.currentTarget.files?.[0] ?? null);
	event.currentTarget.value = "";
}
</script>

<FormField {label} {help} {id} {required} {error}>
	{#snippet children(field)}
		<input
			{...field}
			{id}
			type="file"
			{accept}
			onchange={handleChange}
			class="{INPUT_CLASS} file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink {tone === 'white' ? 'file:bg-white' : 'file:bg-cream'}"
		/>
		{#if status}
			{@render status()}
		{:else if value instanceof File}
			<p class="text-xs text-stone-soft">Selected: {value.name}</p>
		{:else if value}
			<p class="text-xs text-stone-soft">{existingLabel}: {value.fileName}</p>
		{/if}
	{/snippet}
</FormField>
