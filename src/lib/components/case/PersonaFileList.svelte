<script lang="ts">
import { fieldDomId } from "#lib/case/fieldPath.js";
import { focusField } from "#lib/case/focusField.js";
import type { Persona } from "#lib/types.js";
import { type FieldPath, filePath } from "#shared/rules.js";
import Button from "../ui/Button.svelte";
import FileField from "../ui/FileField.svelte";
import FormField, { INPUT_CLASS } from "../ui/FormField.svelte";
import Hint, { HINT_CLASS } from "../ui/Hint.svelte";

type Props = {
	personaId: string;
	files: Persona["files"];
	errorFor: (path: FieldPath) => string | undefined;
};

let { personaId, files = $bindable(), errorFor }: Props = $props();

// Adds an empty shareable-file entry and opens it.
function addFile(): void {
	files.push({ file: null, shareConditions: "", perceivedContents: "" });
	void focusField(filePath(personaId, files.length - 1, "file"));
}

// Removes the shareable-file entry at the given index.
function removeFile(fileIndex: number): void {
	files.splice(fileIndex, 1);
}

// Returns the name of the file attached to an entry, if there is one.
const attachedName = (file: Persona["files"][number]["file"]): string =>
	file instanceof File ? file.name : (file?.fileName ?? "");
</script>

	<div class="flex items-center justify-between gap-2">
		<Hint text="Personas can't read these files. They only know the file name and your description. Students receive the file when the condition is met.">
			{#snippet children(hintProps)}
				<span {...hintProps} class="{HINT_CLASS} text-xs font-medium text-stone-soft">Files this persona can share</span>
			{/snippet}
		</Hint>
		<Button size="sm" onclick={addFile}>+ Add file</Button>
	</div>

	{#if files.length > 0}
		<div class="flex flex-col gap-3">
			{#each files as fileEntry, fileIndex (fileIndex)}
				{@const uploadPath = filePath(personaId, fileIndex, "file")}
				{@const conditionsPath = filePath(personaId, fileIndex, "shareConditions")}
				{@const uploadId = fieldDomId(uploadPath)}
				{@const conditionsId = fieldDomId(conditionsPath)}
				{@const perceivedId = fieldDomId(filePath(personaId, fileIndex, "perceivedContents"))}
				{@const fileName = attachedName(fileEntry.file)}
				<!-- Remove sits beside the <details>, not inside its <summary>, so the summary stays free of interactive content. -->
				<div class="relative">
					<button
						type="button"
						onclick={() => removeFile(fileIndex)}
						class="absolute right-3 top-2.5 rounded-md px-2 py-1 text-xs font-semibold text-stone-soft transition hover:text-brand"
					>
						Remove
					</button>
					<details class="rounded-xl border border-line-soft bg-cream/40">
						<summary class="cursor-pointer select-none truncate px-4 py-3 pr-24 text-sm font-semibold text-ink">
							File {fileIndex + 1}{fileName ? ` · ${fileName}` : ''}
						</summary>
						<div class="flex flex-col gap-3 border-t border-line-soft px-4 py-4">
						<FileField
							label="File"
							help="The file students receive."
							id={uploadId}
							required
							error={errorFor(uploadPath)}
							value={fileEntry.file}
							onChange={(file) => (fileEntry.file = file)}
							existingLabel="Existing file"
							tone="white"
						/>
						<FormField
							label="When to share it"
							help="The persona decides from the conversation whether this has happened."
							id={conditionsId}
							required
							error={errorFor(conditionsPath)}
						>
							{#snippet children(field)}
								<textarea
									{...field}
									id={conditionsId}
									rows="2"
									placeholder="e.g. once the student asks for the budget"
									bind:value={fileEntry.shareConditions}
									class={INPUT_CLASS}
								></textarea>
							{/snippet}
						</FormField>
						<FormField
							label="What the persona believes it contains"
							help="All the persona knows about the contents. It can differ from the real file. Optional."
							id={perceivedId}
						>
							{#snippet children(field)}
								<textarea
									{...field}
									id={perceivedId}
									rows="2"
									placeholder="e.g. last quarter's budget"
									bind:value={fileEntry.perceivedContents}
									class={INPUT_CLASS}
								></textarea>
							{/snippet}
						</FormField>
						</div>
					</details>
				</div>
			{/each}
		</div>
	{/if}
