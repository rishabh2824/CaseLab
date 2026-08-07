import { redirect } from "@sveltejs/kit";
import { goto } from "$app/navigation";
import { apiFetch } from "./api/client.js";
import { ADMIN_ROLE } from "./constants.js";
import { session } from "./session.svelte.js";
import type { Api } from "./types.js";

export type AdminIdentity = { adminRole: Api<"AdminRole">; adminEmail: string };

// Spelled out by hand for admin/+layout.ts's load return type -- see the comment there for
// why svelte-kit sync's generated LayoutData/PageData can't be trusted for this route.
export type AdminLayoutData = { admin: Promise<AdminIdentity | null> };

// Confirms the admin session against the server. Deliberately NOT awaited by the admin
// layout's load (see +layout.ts) -- it fires in parallel with whatever data each admin
// page fetches on its own (component-level onMount calls, not SvelteKit load functions),
// instead of gating every admin route behind a guaranteed serial round trip before
// anything else can even start loading. +layout.svelte awaits this promise itself to
// redirect away once it settles; a page that needs the resolved identity before doing its
// own work (e.g. admins/+page.ts's super-admin gate) awaits it too via
// `(await parent()).admin`.
export async function fetchAdmin(): Promise<AdminIdentity | null> {
	try {
		const me = await apiFetch<Api<"LoginResponse">>("/api/admin/me");
		const admin = { adminRole: me.role, adminEmail: me.email };
		session.setAdmin(admin);
		return admin;
	} catch {
		session.clearAdmin();
		return null;
	}
}

export function requireSuperAdmin(): void {
	if (session.adminRole !== ADMIN_ROLE.SUPER) redirect(302, "/admin");
}

export async function signOutAdmin(): Promise<void> {
	session.clearAdmin();
	await goto("/");
	try {
		await apiFetch("/api/admin/logout", { method: "POST" });
	} catch {}
}
