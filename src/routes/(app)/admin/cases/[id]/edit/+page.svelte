<script lang="ts">
import CaseForm from "#lib/components/CaseForm.svelte";
import { page } from "$app/state";
</script>

<CaseForm mode="edit" caseId={page.params.id} />
