import { redirect } from "@sveltejs/kit";
import { ADMIN_ROLE, type AdminRole } from "./constants.js";
import { session } from "./session.svelte.js";

export type AdminIdentity = { adminRole: AdminRole; adminEmail: string };

// Spelled out by hand for admin/+layout.ts's load return type -- see the comment there for
// why svelte-kit sync's generated LayoutData/PageData can't be trusted for this route.
export type AdminLayoutData = { admin: Promise<AdminIdentity | null> };

export function requireSuperAdmin(): void {
	if (session.adminRole !== ADMIN_ROLE.SUPER) redirect(302, "/admin");
}
