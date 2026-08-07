<script lang="ts">
import type { Snippet } from "svelte";
import { goto } from "$app/navigation";
import AdminTopBar from "$lib/components/AdminTopBar.svelte";
import type { AdminLayoutData } from "$lib/auth.js";

// AdminLayoutData, not PageData from ./$types -- see the comment on +layout.ts's load.
type Props = { data: AdminLayoutData; children: Snippet };

let { data, children }: Props = $props();

// The identity check (+layout.ts) runs in parallel with the page's own data instead of
// gating it -- so an unauthenticated visitor briefly sees the admin shell start to render
// before landing here once the check settles and sends them back to "/".
$effect(() => {
	data.admin.then((admin) => {
		if (!admin) goto("/", { replaceState: true });
	});
});
</script>

<AdminTopBar />
{@render children()}
