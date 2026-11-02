import { type ObjectType, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError, ERROR_CODE } from "../shared/errors";
import {
	ACCESS_CODE_CONFLICT,
	getCaseIssues,
	normalizeAccessCode,
} from "../shared/rules";
import {
	type CaseStructure,
	type CollaboratorPayload,
	caseStructureValidator,
	collaboratorValidator,
	type FileRefPayload,
	fileRefValidator,
} from "../shared/validators";
import { loadCaseForAccess, requireCaseAccess } from "./caseAccess";
import { trimStructure, validateGraph } from "./caseStructure";
import { requireStoredFiles, syncCaseFiles } from "./files";

// Deletes a case along with its file links and collaborators, without an access check.
export async function deleteCaseUnchecked(
	ctx: MutationCtx,
	caseId: Id<"cases">,
): Promise<void> {
	await syncCaseFiles(ctx, caseId, new Set());
	await replaceCollaborators(ctx, caseId, []);
	await ctx.db.delete("cases", caseId);
}

// Deletes a case after checking the admin has access to it.
export async function deleteCase(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
): Promise<void> {
	await loadCaseForAccess(ctx, caseId, admin);
	await deleteCaseUnchecked(ctx, caseId);
}

export const casePayloadArgs = {
	name: v.string(),
	brief: v.string(),
	commonInformation: v.string(),
	duration: v.optional(v.number()),
	accessCode: v.string(),
	structure: caseStructureValidator,
	teachingNotes: v.optional(fileRefValidator),
	collaborators: v.array(collaboratorValidator),
};
export type CasePayload = ObjectType<typeof casePayloadArgs>;

// Normalizes an access code and checks no other case uses it, allowing the case being edited to keep its own.
async function ensureAccessCodeFree(
	ctx: QueryCtx | MutationCtx,
	accessCode: string,
	excludeCaseId?: Id<"cases">,
): Promise<string> {
	const normalized = normalizeAccessCode(accessCode);
	const existing = await ctx.db
		.query("cases")
		.withIndex("by_access_code", (q) => q.eq("accessCode", normalized))
		.first();
	if (existing !== null && existing._id !== excludeCaseId) {
		throw appError(ERROR_CODE.ACCESS_CODE_TAKEN, ACCESS_CODE_CONFLICT);
	}
	return normalized;
}

// Syncs a case's collaborator rows to the given collaborators, keeping unchanged rows intact.
async function replaceCollaborators(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	collaborators: CollaboratorPayload[],
): Promise<void> {
	const existing = await ctx.db
		.query("collaborators")
		.withIndex("by_case_and_admin", (q) => q.eq("caseId", caseId))
		.collect();
	const desired = new Map(collaborators.map((c) => [c.adminId, c.access]));
	const existingAdminIds = new Set(existing.map((row) => row.adminId));

	for (const row of existing) {
		const access = desired.get(row.adminId);
		if (access === undefined) await ctx.db.delete("collaborators", row._id);
		else if (row.access !== access)
			await ctx.db.patch("collaborators", row._id, { access });
	}
	for (const [adminId, access] of desired) {
		if (!existingAdminIds.has(adminId)) {
			await ctx.db.insert("collaborators", { caseId, adminId, access });
		}
	}
}

// Validates and normalizes a create/update payload into the fields and files to store.
async function resolveCasePayload(
	ctx: MutationCtx,
	payload: CasePayload,
	excludeCaseId?: Id<"cases">,
): Promise<{
	fields: {
		name: string;
		brief: string;
		commonInformation: string;
		accessCode: string;
		duration: number | undefined;
		structure: CaseStructure;
		teachingNotes: FileRefPayload | undefined;
	};
	storageIds: Set<Id<"_storage">>;
}> {
	const firstIssue = getCaseIssues({
		...payload,
		duration: payload.duration ?? null,
		personas: payload.structure.personas,
		referrals: payload.structure.referrals,
	})[0];
	if (firstIssue) throw appError(ERROR_CODE.INVALID_CASE, firstIssue.message);

	const name = payload.name.trim();
	const brief = payload.brief.trim();
	const commonInformation = payload.commonInformation.trim();
	const accessCode = await ensureAccessCodeFree(
		ctx,
		payload.accessCode,
		excludeCaseId,
	);
	const duration = payload.duration;
	const { personas, referrals } = payload.structure;
	validateGraph(personas, referrals);
	const storageIds = await requireStoredFiles(ctx, [
		payload.teachingNotes,
		...personas.flatMap((persona) => [
			persona.profilePhoto,
			...persona.files.map((entry) => entry.file),
		]),
	]);
	return {
		fields: {
			name,
			brief,
			commonInformation,
			accessCode,
			duration,
			structure: trimStructure(payload.structure),
			teachingNotes: payload.teachingNotes,
		},
		storageIds,
	};
}

// Creates a case owned by the admin, with its collaborators and file links.
export async function createCase(
	ctx: MutationCtx,
	payload: CasePayload,
	admin: Doc<"admins">,
): Promise<Id<"cases">> {
	const { fields, storageIds } = await resolveCasePayload(ctx, payload);

	const caseId = await ctx.db.insert("cases", {
		...fields,
		ownerAdminId: admin._id,
		isTemplate: false,
	});

	await replaceCollaborators(ctx, caseId, payload.collaborators);
	await syncCaseFiles(ctx, caseId, storageIds);

	return caseId;
}

// Updates a case the admin can access, re-syncing its collaborators and file links.
export async function updateCase(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	payload: CasePayload,
	admin: Doc<"admins">,
): Promise<void> {
	await loadCaseForAccess(ctx, caseId, admin);

	const { fields, storageIds } = await resolveCasePayload(ctx, payload, caseId);

	await ctx.db.patch("cases", caseId, fields);

	await replaceCollaborators(ctx, caseId, payload.collaborators);
	await syncCaseFiles(ctx, caseId, storageIds);
}

// Loads a case to copy as a template, without its access code, owner or teaching notes. Allowed for flagged templates and for cases the caller can access.
export async function getTemplateView(
	ctx: QueryCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
) {
	const c = await ctx.db.get("cases", caseId);
	if (!c) throw appError(ERROR_CODE.CASE_NOT_FOUND, "Case not found.");
	if (!c.isTemplate) await requireCaseAccess(ctx, c, admin, "view");
	const {
		accessCode: _accessCode,
		ownerAdminId: _ownerAdminId,
		teachingNotes: _teachingNotes,
		...template
	} = c;
	return template;
}

// Loads a case the admin can see, plus its collaborators and whether they may edit it, for the case form.
export async function getCaseForEdit(
	ctx: QueryCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
) {
	const c = await ctx.db.get("cases", caseId);
	if (!c) throw appError(ERROR_CODE.CASE_NOT_FOUND, "Case not found.");
	const access = await requireCaseAccess(ctx, c, admin, "view");
	const collaboratorRows = await ctx.db
		.query("collaborators")
		.withIndex("by_case_and_admin", (q) => q.eq("caseId", c._id))
		.collect();
	return {
		...c,
		collaborators: collaboratorRows.map(({ adminId, access }) => ({
			adminId,
			access,
		})),
		canEdit: access === "edit",
		teachingNotesUrl: c.teachingNotes
			? await ctx.storage.getUrl(c.teachingNotes.storageId)
			: null,
	};
}

// Turns a case's template flag on or off.
export async function setTemplateFlag(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	isTemplate: boolean,
): Promise<void> {
	if (!(await ctx.db.get("cases", caseId)))
		throw appError(ERROR_CODE.CASE_NOT_FOUND, "Case not found.");
	await ctx.db.patch("cases", caseId, { isTemplate });
}
