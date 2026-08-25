import { v } from "convex/values";
import { query } from "../_generated/server";
import { authComponent } from "../auth";
import { adminQuery, superAdminMutation } from "../lib/adminFunctions";
import { adminRole } from "../schema";
import {
	createAdmin,
	deleteAdminWithCascade,
	getAdminByEmail,
	listAdmins,
} from "../services/admins";

// The current admin's identity + role, or null if not signed in / not an admin.
// Gates the frontend UI — the actual authorization enforcement lives in
// auth.ts's databaseHooks.user.create.before, which never lets a non-admin
// Google account reach a signed-in state in the first place.
export const viewer = query({
	args: {},
	handler: async (ctx) => {
		const user = await authComponent.safeGetAuthUser(ctx);
		if (!user?.email) return null;

		const admin = await getAdminByEmail(ctx, user.email);
		if (!admin) return null;

		return { email: admin.email, name: admin.name, role: admin.role };
	},
});

// Any signed-in admin can see the full roster, not just super admins.
export const listAll = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await listAdmins(ctx);
	},
});

export const create = superAdminMutation({
	args: { email: v.string(), name: v.optional(v.string()), role: adminRole },
	handler: async (ctx, args) => {
		return await createAdmin(ctx, args);
	},
});

export const deleteWithCascade = superAdminMutation({
	args: { adminId: v.id("admins") },
	handler: async (ctx, args) => {
		return await deleteAdminWithCascade(ctx, args.adminId);
	},
});
