import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { env } from "../_generated/server";
import { adminMutation, adminQuery } from "../lib/adminFunctions";
import {
	personaPayloadValidator,
	referralEdgeValidator,
} from "../models/cases";
import {
	createCase,
	deleteCase as deleteCaseWithAccess,
	listCases,
	loadCaseForAccess,
	updateCase,
} from "../services/cases";

// Returns the configured demo case, or null if none is set or it cannot be loaded.
export const getDemo = adminQuery({
	args: {},
	handler: async (ctx) => {
		if (!env.DEMO_CASE_ID) return null;
		try {
			return await ctx.db.get("cases", env.DEMO_CASE_ID as Id<"cases">);
		} catch {
			return null;
		}
	},
});

// Loads a case the caller can access, plus its collaborator admin ids, for the edit form.
export const getForEdit = adminQuery({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		const c = await loadCaseForAccess(ctx, args.caseId, ctx.admin);
		const collaboratorRows = await ctx.db
			.query("collaborators")
			.withIndex("by_case_and_admin", (q) => q.eq("caseId", c._id))
			.collect();
		return {
			...c,
			collaboratorAdminIds: collaboratorRows.map((row) => row.adminId),
		};
	},
});

// Lists the cases the calling admin can see.
export const listAll = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await listCases(ctx, ctx.admin);
	},
});

// Deletes a case the caller has access to.
export const deleteCase = adminMutation({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		await deleteCaseWithAccess(ctx, args.caseId, ctx.admin);
	},
});

const casePayloadArgs = {
	name: v.string(),
	brief: v.string(),
	commonInformation: v.optional(v.string()),
	duration: v.optional(v.number()),
	accessCode: v.string(),
	personas: v.array(personaPayloadValidator),
	referrals: v.array(referralEdgeValidator),
	roots: v.array(v.string()),
	collaboratorAdminIds: v.array(v.id("admins")),
};

// Creates a case owned by the calling admin and returns its id.
export const create = adminMutation({
	args: casePayloadArgs,
	handler: async (ctx, args) => {
		const caseId = await createCase(ctx, args, ctx.admin);
		return { caseId };
	},
});

// Updates an existing case the caller has access to and returns its id.
export const update = adminMutation({
	args: { caseId: v.id("cases"), ...casePayloadArgs },
	handler: async (ctx, args) => {
		const { caseId, ...payload } = args;
		await updateCase(ctx, caseId, payload, ctx.admin);
		return { caseId };
	},
});
