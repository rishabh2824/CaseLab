import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import {
	personaPayloadValidator,
	referralEdgeValidator,
} from "../models/cases";
import { requireCurrentAdmin } from "../services/admins";
import {
	createCase,
	deleteCase as deleteCaseWithAccess,
	listCases,
	requireCaseAccess,
	updateCase,
} from "../services/cases";

// Read-only single-case fetch -- used by DemoCaseView.svelte for its hardcoded demo case.
// Enforces the same owner-or-collaborator-or-super access as getForEdit below, and for the
// same reason: `caseId` is caller-supplied, so an "any signed-in admin" exemption here isn't
// scoped to the demo case -- it hands ANY admin ANY other admin's whole case document,
// including its `accessCode` (all a student needs to launch that simulation) and every
// persona's `known_facts`. A case meant to be a shared example is shared via the normal
// collaborator mechanism (or is visible to super admins), not by exempting the read path.
export const get = query({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		const admin = await requireCurrentAdmin(ctx);
		const c = await ctx.db.get(args.caseId);
		if (!c) return null;
		await requireCaseAccess(ctx, c, admin);
		return c;
	},
});

// Mirrors backend/api/cases.py's GET /cases/{case_id} access control -- used by
// CaseForm.svelte both to load an existing case for editing and to load one as a
// create-from-template source (the same query serves both; a template load simply doesn't
// read collaboratorAdminIds, since a new case starts with none regardless of the source
// case's own list).
export const getForEdit = query({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		const admin = await requireCurrentAdmin(ctx);
		const c = await ctx.db.get(args.caseId);
		if (!c) throw new Error("Case not found.");
		await requireCaseAccess(ctx, c, admin);
		const collaboratorRows = await ctx.db
			.query("collaborators")
			.withIndex("by_case", (q) => q.eq("caseId", c._id))
			.collect();
		return {
			...c,
			collaboratorAdminIds: collaboratorRows.map((row) => row.adminId),
		};
	},
});

// Mirrors backend/api/cases.py's GET /cases: owner-or-collaborator visibility, SUPER
// admins see everything.
export const listAll = query({
	args: {},
	handler: async (ctx) => {
		const admin = await requireCurrentAdmin(ctx);
		return await listCases(ctx, admin);
	},
});

// Mirrors backend/api/cases.py's DELETE /cases/{case_id}.
export const deleteCase = mutation({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		const admin = await requireCurrentAdmin(ctx);
		await deleteCaseWithAccess(ctx, args.caseId, admin);
	},
});

// Shared by create/update below -- a CasePayload's fields (see services/cases.ts), as
// Convex validators.
const casePayloadArgs = {
	name: v.string(),
	brief: v.string(),
	commonInformation: v.optional(v.string()),
	duration: v.optional(v.number()),
	accessCode: v.optional(v.string()),
	personas: v.array(personaPayloadValidator),
	referrals: v.array(referralEdgeValidator),
	roots: v.array(v.string()),
	collaboratorAdminIds: v.array(v.id("admins")),
};

// Mirrors backend/api/cases.py's POST /cases.
export const create = mutation({
	args: casePayloadArgs,
	handler: async (ctx, args) => {
		const admin = await requireCurrentAdmin(ctx);
		const caseId = await createCase(ctx, args, admin);
		return { caseId };
	},
});

// Mirrors backend/api/cases.py's PUT /cases/{case_id}, minus the expected_version conflict
// check -- see schema.ts's comment on `cases` for why last-write-wins replaces it.
export const update = mutation({
	args: { caseId: v.id("cases"), ...casePayloadArgs },
	handler: async (ctx, args) => {
		const admin = await requireCurrentAdmin(ctx);
		const { caseId, ...payload } = args;
		await updateCase(ctx, caseId, payload, admin);
		return { caseId };
	},
});
