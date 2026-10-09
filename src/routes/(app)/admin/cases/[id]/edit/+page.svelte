<script lang="ts">
import CaseForm from "#lib/components/CaseForm.svelte";
import { page } from "$app/state";
</script>

<!-- A fresh form per case, so nothing from the previous case lingers and a late response cannot land in the wrong form. -->
{#key page.params.id}
	<CaseForm mode="edit" caseId={page.params.id} />
{/key}
