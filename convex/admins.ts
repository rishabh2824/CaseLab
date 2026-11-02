import { v } from "convex/values";
import { query } from "./_generated/server";
import {
	createAdmin,
	deleteAdminWithCascade,
	listAdmins,
	viewerProfile,
} from "./model/admins";
import { adminQuery, superAdminMutation } from "./model/functions";
import { adminRole } from "./shared/validators";

// Returns the signed-in admin's basic profile, or null for anonymous and non-admin callers.
export const viewer = query({
	args: {},
	handler: async (ctx) => viewerProfile(ctx),
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
	args: { email: v.string(), name: v.string(), role: adminRole },
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
