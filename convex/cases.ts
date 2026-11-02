import { v } from "convex/values";
import { listCases, listTemplateChoices } from "./model/caseLists";
import {
	casePayloadArgs,
	createCase,
	deleteCase as deleteCaseWithAccess,
	getCaseForEdit,
	getTemplateView,
	setTemplateFlag,
	updateCase,
} from "./model/cases";
import {
	adminMutation,
	adminQuery,
	superAdminMutation,
} from "./model/functions";

// Lists the cases the caller can copy as a template: their own plus every case flagged as a template, by id and name only.
export const listTemplates = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await listTemplateChoices(ctx, ctx.admin);
	},
});

// Loads a case to copy as a template, without its access code, owner or teaching notes.
export const getTemplate = adminQuery({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		return await getTemplateView(ctx, args.caseId, ctx.admin);
	},
});

// Turns a case's template flag on or off; super admins only.
export const setTemplate = superAdminMutation({
	args: { caseId: v.id("cases"), isTemplate: v.boolean() },
	handler: async (ctx, args) => {
		await setTemplateFlag(ctx, args.caseId, args.isTemplate);
	},
});

// Loads a case the caller can see, plus its collaborators and whether the caller may edit it, for the case form.
export const getForEdit = adminQuery({
	args: { caseId: v.id("cases") },
	handler: async (ctx, args) => {
		return await getCaseForEdit(ctx, args.caseId, ctx.admin);
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
