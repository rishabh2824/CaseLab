import {
	customMutation,
	customQuery,
} from "convex-helpers/server/customFunctions";
import { mutation, query } from "../_generated/server";
import { requireCurrentAdmin, requireSuperAdmin } from "./admins";

// Defines a query that requires a signed-in admin, who is passed on the context.
export const adminQuery = customQuery(query, {
	args: {},
	input: async (ctx) => ({
		ctx: { admin: await requireCurrentAdmin(ctx) },
		args: {},
	}),
});

// Defines a mutation that requires a signed-in admin, who is passed on the context.
export const adminMutation = customMutation(mutation, {
	args: {},
	input: async (ctx) => ({
		ctx: { admin: await requireCurrentAdmin(ctx) },
		args: {},
	}),
});

// Defines a mutation that requires a super admin, who is passed on the context.
export const superAdminMutation = customMutation(mutation, {
	args: {},
	input: async (ctx) => ({
		ctx: { admin: await requireSuperAdmin(ctx) },
		args: {},
	}),
});
