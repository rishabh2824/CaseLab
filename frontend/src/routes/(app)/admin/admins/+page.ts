import { requireSuperAdmin } from "$lib/auth.js";
import type { AdminLayoutData } from "$lib/auth.js";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ parent }) => {
	// This page's own gate genuinely needs the resolved role first (can't decide whether to
	// show admin-management data without knowing who's asking), so it awaits the identity
	// check specifically -- awaiting `parent()` alone isn't enough now that the layout
	// returns that check as an unresolved promise instead of awaiting it itself.
	// Cast, not PageParentData, for the same reason +layout.svelte uses AdminLayoutData
	// directly -- see the comment on admin/+layout.ts's load.
	const { admin } = (await parent()) as AdminLayoutData;
	await admin;
	requireSuperAdmin();
};
