import { ConvexError, v } from "convex/values";
import {
	adminMutation,
	adminQuery,
	superAdminMutation,
} from "../lib/adminFunctions";
import {
	personaPayloadValidator,
	referralEdgeValidator,
} from "../models/cases";
import {
	createCase,
	deleteCase as deleteCaseWithAccess,
	listCases,
	listDemoCases,
	loadCaseForAccess,
	updateCase,
} from "../services/cases";

// Lists the cases flagged as demos, by id and name only.
export const listDemos = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await listDemoCases(ctx);
	},
});

// Returns a demo case without its access code or owner, or null if the id is not a demo case.
export const getDemo = adminQuery({
	args: { caseId: v.string() },
	handler: async (ctx, args) => {
		const id = ctx.db.normalizeId("cases", args.caseId);
		const c = id ? await ctx.db.get("cases", id) : null;
		if (!c?.isDemo) return null;
		const { accessCode: _accessCode, ownerAdminId: _ownerAdminId, ...demo } = c;
		return demo;
	},
});

// Turns a case's demo flag on or off; super admins only.
export const setDemo = superAdminMutation({
	args: { caseId: v.id("cases"), isDemo: v.boolean() },
	handler: async (ctx, args) => {
		if (!(await ctx.db.get("cases", args.caseId)))
			throw new ConvexError("Case not found.");
		await ctx.db.patch("cases", args.caseId, { isDemo: args.isDemo });
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
	commonInformation: v.string(),
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
