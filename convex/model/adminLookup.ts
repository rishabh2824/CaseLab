import type { QueryCtx } from "../_generated/server";

// Trims and lower-cases an email so lookups ignore casing and padding.
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

// Finds an admin by email, ignoring casing and padding. Kept free of auth imports so sign-in can use it without a cycle.
export async function getAdminByEmail(ctx: QueryCtx, email: string) {
	return ctx.db
		.query("admins")
		.withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
		.unique();
}
