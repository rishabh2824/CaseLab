import { v } from "convex/values";
import { query } from "../_generated/server";
import { authComponent } from "../auth";
import { adminRole } from "../schema";
import { adminQuery, superAdminMutation } from "../services/adminFunctions";
import {
	createAdmin,
	deleteAdminWithCascade,
	getAdminByEmail,
	listAdmins,
} from "../services/admins";

// Returns the signed-in admin's basic profile, or null for anonymous and non-admin callers.
export const viewer = query({
	args: {},
	handler: async (ctx) => {
		const user = await authComponent.safeGetAuthUser(ctx);
		if (!user?.email) return null;

		const admin = await getAdminByEmail(ctx, user.email);
		if (!admin) return null;

		return {
			_id: admin._id,
			email: admin.email,
			name: admin.name,
			role: admin.role,
		};
	},
});

// Lists every admin on the roster.
export const listAll = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await listAdmins(ctx);
	},
});

// Creates a new admin (super admins only).
export const create = superAdminMutation({
	args: { email: v.string(), name: v.optional(v.string()), role: adminRole },
	handler: async (ctx, args) => {
		return await createAdmin(ctx, args);
	},
});

// Deletes an admin and cascades through their cases and sessions (super admins only).
export const deleteWithCascade = superAdminMutation({
	args: { adminId: v.id("admins") },
	handler: async (ctx, args) => {
		return await deleteAdminWithCascade(ctx, args.adminId);
	},
});
