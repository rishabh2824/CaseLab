<script lang="ts">
import CaseForm from "#lib/components/CaseForm.svelte";
import { page } from "$app/state";

const templateId = $derived(page.url.searchParams.get("template"));
</script>

<!-- A fresh form per template, so nothing from the previous template lingers and a late response cannot land in the wrong form. -->
{#key templateId}
	<CaseForm mode="create" {templateId} />
{/key}
