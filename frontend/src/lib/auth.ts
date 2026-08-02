import { redirect } from "@sveltejs/kit";
import { goto } from "$app/navigation";
import { apiFetch } from "./api/client.js";
import { ADMIN_ROLE } from "./constants.js";
import { session } from "./session.svelte.js";

// Route guard for any admin-only page.
export function requireAdmin(): void {
	if (session.adminRole == null) redirect(302, "/");
}

export function requireSuperAdmin(): void {
	requireAdmin();
	if (session.adminRole !== ADMIN_ROLE.SUPER) redirect(302, "/admin");
}

// Shared by every admin-panel sign-out control.
export async function signOutAdmin(): Promise<void> {
	session.clearAdmin();
	await goto("/");
	try {
		await apiFetch("/api/admin/logout", { method: "POST" });
	} catch {
		// best-effort — the cookie will simply expire on its own otherwise
	}
}
