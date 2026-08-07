import { fetchAdmin } from "$lib/auth.js";
import type { LayoutLoad } from "./$types";

// Return type is also spelled out by hand as AdminLayoutData (auth.js) -- svelte-kit
// sync's $types generation can't infer it in this repo (a pre-existing environment bug:
// typescript@7.0.2 is outside @sveltejs/kit's supported peer range of ^5.3.3 || ^6.0.0,
// which breaks its internal type-generation step and silently degrades every route's
// PageData/LayoutData to `unknown` -- reproduces even for a brand-new trivial route, so
// it's unrelated to this file specifically). Consumers (+layout.svelte, admins/+page.ts)
// import AdminLayoutData directly instead of trusting LayoutData/PageData here.
export const load: LayoutLoad = () => {
	// Not awaited: lets the whole admin subtree mount immediately (and each page fire its
	// own onMount data fetch) instead of blocking on this round trip first. See
	// +layout.svelte, which awaits this itself to redirect away once it settles.
	return { admin: fetchAdmin() };
};
