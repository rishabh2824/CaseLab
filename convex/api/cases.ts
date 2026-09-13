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

// The one shared example case every signed-in admin can see, read-only, regardless of
// ownership/collaborator status -- used by DemoCaseView.svelte. This is safe to expose without
// requireCaseAccess (unlike getForEdit below) specifically BECAUSE the id comes from the
// DEMO_CASE_ID app env var (convex.config.ts, set per deployment via `npx convex env set`),
// not a caller-supplied argument -- an admin has no way to point this at any other case's
// document, so there's nothing for an "any signed-in admin" exemption to leak. Returns null
// (not an error) when DEMO_CASE_ID isn't set for this deployment, or resolves to nothing --
// a missing demo case is a deployment-configuration gap, not something to surface as a broken
// query.
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
	// Every case must have a unique access code -- see validateAccessCode (services/cases.ts)
	// for the actual required-and-unique enforcement. Required here too (not v.optional like
	// commonInformation/duration) so a direct call missing the field entirely is rejected by
	// argument validation, matching name/brief above rather than accessCode's old optional
	// shape from when a case could be saved without a launchable code.
	accessCode: v.string(),
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
