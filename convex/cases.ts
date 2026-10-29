import { ConvexError, v } from "convex/values";
import {
	adminMutation,
	adminQuery,
	superAdminMutation,
} from "./services/adminFunctions";
import {
	casePayloadArgs,
	createCase,
	deleteCase as deleteCaseWithAccess,
	listCases,
	listTemplateChoices,
	loadCaseForAccess,
	requireCaseAccess,
	updateCase,
} from "./services/cases";

// Lists the cases the caller can copy as a template: their own plus every case flagged as a template, by id and name only.
export const listTemplates = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await listTemplateChoices(ctx, ctx.admin);
	},
});

// Loads a case to copy as a template, without its access code, owner or teaching notes. Allowed for flagged templates and for cases the caller can access.
export const getTemplate = adminQuery({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		const c = await ctx.db.get("cases", args.caseId);
		if (!c) throw new ConvexError("Case not found.");
		if (!c.isTemplate) await requireCaseAccess(ctx, c, ctx.admin, "view");
		const {
			accessCode: _accessCode,
			ownerAdminId: _ownerAdminId,
			teachingNotes: _teachingNotes,
			...template
		} = c;
		return template;
	},
});

// Turns a case's template flag on or off; super admins only.
export const setTemplate = superAdminMutation({
	args: { caseId: v.id("cases"), isTemplate: v.boolean() },
	handler: async (ctx, args) => {
		if (!(await ctx.db.get("cases", args.caseId)))
			throw new ConvexError("Case not found.");
		await ctx.db.patch("cases", args.caseId, { isTemplate: args.isTemplate });
	},
});

// Loads a case the caller can see, plus its collaborators and whether the caller may edit it, for the case form.
export const getForEdit = adminQuery({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		const c = await loadCaseForAccess(ctx, args.caseId, ctx.admin, "view");
		const collaboratorRows = await ctx.db
			.query("collaborators")
			.withIndex("by_case_and_admin", (q) => q.eq("caseId", c._id))
			.collect();
		const canEdit =
			ctx.admin.role === "super" ||
			c.ownerAdminId === ctx.admin._id ||
			collaboratorRows.some(
				(row) => row.adminId === ctx.admin._id && row.access === "edit",
			);
		return {
			...c,
			collaborators: collaboratorRows.map(({ adminId, access }) => ({
				adminId,
				access,
			})),
			canEdit,
			teachingNotesUrl: c.teachingNotes
				? await ctx.storage.getUrl(c.teachingNotes.storageId)
				: null,
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
