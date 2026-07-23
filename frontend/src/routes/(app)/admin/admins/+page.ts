import { requireSuperAdmin } from "$lib/auth.js";
import type { PageLoad } from "./$types";

export const load: PageLoad = () => {
	requireSuperAdmin();
};
