<script lang="ts">
import { useQuery } from "convex-svelte";
import { api } from "#convex/api.js";
import CaseList from "#lib/components/case/CaseList.svelte";

const templatesQuery = useQuery(api.cases.listTemplates, {});
</script>

<CaseList
	eyebrow="Choose Template"
	title="Select an existing case"
	description="The selected case will be copied into a new form. Saving it will create a brand-new case and leave the original untouched."
	query={templatesQuery}
	href={(item) => `/admin/cases/new/template/${item._id}`}
/>
