import { requireSuperAdmin } from "$lib/auth.js";
import type { PageLoad } from "./$types";

// requireSuperAdmin() reads session.adminRole directly (a plain module-level store), not
// anything from the load-function chain -- by the time this fires, admin/+layout.svelte's
// own gate has already populated it from the live `viewer` query and rendered its children,
// so there's nothing here for `parent()` to add.
export const load: PageLoad = () => {
	requireSuperAdmin();
};
