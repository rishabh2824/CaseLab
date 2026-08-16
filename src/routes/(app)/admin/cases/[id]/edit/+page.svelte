<script lang="ts">
import { page } from "$app/state";
import CaseForm from "$lib/components/CaseForm.svelte";
</script>

<CaseForm mode="edit" caseId={page.params.id} />
