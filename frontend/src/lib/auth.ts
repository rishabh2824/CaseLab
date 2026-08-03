import { redirect } from "@sveltejs/kit";
import { goto } from "$app/navigation";
import { apiFetch } from "./api/client.js";
import { ADMIN_ROLE } from "./constants.js";
import { session } from "./session.svelte.js";
import type { Api } from "./types.js";

// Route guard for any admin-only page. Confirms the session cookie is still
// valid server-side (rather than trusting whatever's cached in
// sessionStorage), so a revoked/expired admin bounces home instead of seeing
// admin UI that 401s on every call.
export async function requireAdmin(): Promise<void> {
	try {
		const me = await apiFetch<Api<"LoginResponse">>("/api/admin/me");
		session.setAdmin({ adminRole: me.role, adminEmail: me.email });
	} catch {
		session.clearAdmin();
		redirect(302, "/");
	}
}

export async function requireSuperAdmin(): Promise<void> {
	await requireAdmin();
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
