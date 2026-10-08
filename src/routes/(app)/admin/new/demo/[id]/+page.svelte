<script lang="ts">
import DemoCaseView from "#lib/components/DemoCaseView.svelte";
import { page } from "$app/state";
</script>

<DemoCaseView caseId={page.params.id ?? ""} />
