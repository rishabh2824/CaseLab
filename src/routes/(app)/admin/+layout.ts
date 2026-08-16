import type { AdminIdentity } from "$lib/auth.js";
import { session } from "$lib/session.svelte.js";
import type { LayoutLoad } from "./$types";

// Return type is also spelled out by hand as AdminLayoutData (auth.js) -- svelte-kit
// sync's $types generation can't infer it in this repo (a pre-existing environment bug:
// typescript@7.0.2 is outside @sveltejs/kit's supported peer range of ^5.3.3 || ^6.0.0,
// which breaks its internal type-generation step and silently degrades every route's
// PageData/LayoutData to `unknown` -- reproduces even for a brand-new trivial route, so
// it's unrelated to this file specifically). Consumers (+layout.svelte, admins/+page.ts)
// import AdminLayoutData directly instead of trusting LayoutData/PageData here.
//
// Identity now comes from the `session` store (synced from the Convex `viewer` query by
// AdminAuth.svelte, mounted on the landing page during sign-in) instead of an old-backend
// `/api/admin/me` round trip -- a plain module-level singleton, so it's readable here even
// though this load function has no Svelte component context to reach a Convex client
// through.
export const load: LayoutLoad = () => {
	const admin: AdminIdentity | null = session.adminRole
		? { adminRole: session.adminRole, adminEmail: session.adminEmail }
		: null;
	return { admin: Promise.resolve(admin) };
};
