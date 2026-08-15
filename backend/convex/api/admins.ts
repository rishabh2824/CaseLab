import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalQuery, mutation, query } from "../_generated/server";
import { adminRole } from "../models/admin";
import {
	createAdmin,
	deleteAdminWithCascade,
	getAdminByEmail,
	listAdmins,
	requireCurrentAdmin,
	requireSuperAdmin,
} from "../services/admins";

// The current admin's identity + role, or null if not signed in / not an admin.
// Gates the frontend UI — the actual authorization enforcement lives in
// auth.ts's createOrUpdateUser callback, which never lets a non-admin Google
// account reach a signed-in state in the first place.
export const viewer = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) return null;
		const user = await ctx.db.get(userId);
		if (!user?.email) return null;

		const admin = await getAdminByEmail(ctx, user.email);
		if (!admin) return null;

		return { email: admin.email, name: admin.name, role: admin.role };
	},
});

// Mirrors backend/api/admin.py's GET /admin/admins: any signed-in admin can see the
// full roster, not just super admins.
export const listAll = query({
	args: {},
	handler: async (ctx) => {
		await requireCurrentAdmin(ctx);
		return await listAdmins(ctx);
	},
});

// Mirrors backend/api/admin.py's POST /admin/admins (requireSuperAdmin dependency).
export const create = mutation({
	args: { email: v.string(), name: v.optional(v.string()), role: adminRole },
	handler: async (ctx, args) => {
		await requireSuperAdmin(ctx);
		return await createAdmin(ctx, args);
	},
});

// Mirrors backend/api/admin.py's DELETE /admin/admins/{id} (requireSuperAdmin dependency).
export const deleteWithCascade = mutation({
	args: { adminId: v.id("admins") },
	handler: async (ctx, args) => {
		await requireSuperAdmin(ctx);
		return await deleteAdminWithCascade(ctx, args.adminId);
	},
});

// Not client-callable -- lets actions (which have no direct db access, e.g.
// api/uploads.ts's presign actions) reuse the same admin gate every query/mutation uses.
export const requireCurrentAdminInternal = internalQuery({
	args: {},
	handler: async (ctx) => {
		await requireCurrentAdmin(ctx);
	},
});
