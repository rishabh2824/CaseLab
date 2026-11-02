<script lang="ts">
import CaseForm from "#lib/components/case/CaseForm.svelte";
import { page } from "$app/state";
</script>

<!-- A fresh form per template, so nothing from the previous template lingers and a late response cannot land in the wrong form. -->
{#key page.params.id}
	<CaseForm source={{ kind: "template", id: page.params.id! }} />
{/key}
