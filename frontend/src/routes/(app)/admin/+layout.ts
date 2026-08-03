import { requireAdmin } from "$lib/auth.js";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async () => {
	await requireAdmin();
};
