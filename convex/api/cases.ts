import { v } from "convex/values";
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

// Read-only single-case fetch -- used by DemoCaseView.svelte for its hardcoded demo case.
// Enforces the same owner-or-collaborator-or-super access as getForEdit below, and for the
// same reason: `caseId` is caller-supplied, so an "any signed-in admin" exemption here isn't
// scoped to the demo case -- it hands ANY admin ANY other admin's whole case document,
// including its `accessCode` (all a student needs to launch that simulation) and every
// persona's `known_facts`. A case meant to be a shared example is shared via the normal
// collaborator mechanism (or is visible to super admins), not by exempting the read path.
export const get = adminQuery({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		return await loadCaseForAccess(ctx, args.caseId, ctx.admin);
	},
});

// Used by CaseForm.svelte both to load an existing case for editing and to load one as a
// create-from-template source (the same query serves both; a template load simply doesn't
// read collaboratorAdminIds, since a new case starts with none regardless of the source
// case's own list).
export const getForEdit = adminQuery({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		const c = await loadCaseForAccess(ctx, args.caseId, ctx.admin);
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

// Owner-or-collaborator visibility; SUPER admins see everything.
export const listAll = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await listCases(ctx, ctx.admin);
	},
});

export const deleteCase = adminMutation({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		await deleteCaseWithAccess(ctx, args.caseId, ctx.admin);
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

export const create = adminMutation({
	args: casePayloadArgs,
	handler: async (ctx, args) => {
		const caseId = await createCase(ctx, args, ctx.admin);
		return { caseId };
	},
});

// No expected_version conflict check -- see schema.ts's comment on `cases` for why
// last-write-wins replaces it.
export const update = adminMutation({
	args: { caseId: v.id("cases"), ...casePayloadArgs },
	handler: async (ctx, args) => {
		const { caseId, ...payload } = args;
		await updateCase(ctx, caseId, payload, ctx.admin);
		return { caseId };
	},
});
