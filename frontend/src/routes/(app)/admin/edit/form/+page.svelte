<script>
	import { page } from '$app/state'
	import CaseForm from '$lib/components/CaseForm.svelte'
</script>

<CaseForm editCaseId={page.url.searchParams.get('caseId')} />
