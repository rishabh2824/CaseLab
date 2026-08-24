import { redirect } from "@sveltejs/kit";
import { session } from "./session.svelte.js";

export function requireSuperAdmin(): void {
	if (session.adminRole !== "super") redirect(302, "/admin");
}
