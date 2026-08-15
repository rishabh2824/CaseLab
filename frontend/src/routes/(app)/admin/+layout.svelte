<script lang="ts">
import type { Snippet } from "svelte";
import { setupConvexAuth } from "@mmailaender/convex-auth-svelte/svelte";
import { goto } from "$app/navigation";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import AdminTopBar from "$lib/components/AdminTopBar.svelte";
import type { AdminLayoutData } from "$lib/auth.js";

// AdminLayoutData, not PageData from ./$types -- see the comment on +layout.ts's load.
type Props = { data: AdminLayoutData; children: Snippet };

let { data, children }: Props = $props();

// Restores the Convex Auth session (JWT/refresh token) that AdminAuth.svelte stored in
// localStorage during sign-in on the landing page -- admin pages (e.g. admins/+page.svelte)
// need an authenticated Convex client to query/mutate through api/admins.ts. Scoped to this
// layout, not the root one, so students on "/" and "/student" still never load any of this.
// Unlike AdminAuth.svelte's sign-in flow, there's no live auth-state transition happening
// here to work around: this is a cold page load with a token already in storage, which the
// client picks up during its normal initial connect handshake.
setupConvexAuth({ convexUrl: PUBLIC_CONVEX_URL });

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
