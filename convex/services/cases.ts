import { ConvexError, type ObjectType, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getCaseInfoErrors, isSelectableCollaborator } from "../lib/caseRules";
import { cleanStructure, validateGraph } from "../lib/caseStructure";
import {
	type CaseStructure,
	type CollaboratorAccess,
	type CollaboratorPayload,
	caseStructureValidator,
	collaboratorValidator,
	type FileRefPayload,
	fileRefValidator,
} from "../models/cases";
import { existingStorageIds, syncCaseFiles } from "./files";

const ACCESS_CODE_CONFLICT =
	"An access code with this value already exists on another case.";

// Throws unless the admin is a super admin, the case owner or a collaborator with the needed access level.
export async function requireCaseAccess(
	ctx: QueryCtx | MutationCtx,
	c: Doc<"cases">,
	admin: Doc<"admins">,
	need: CollaboratorAccess = "edit",
): Promise<void> {
	if (admin.role === "super") return;
	if (c.ownerAdminId === admin._id) return;
	const collaborating = await ctx.db
		.query("collaborators")
		.withIndex("by_case_and_admin", (q) =>
			q.eq("caseId", c._id).eq("adminId", admin._id),
		)
		.first();
	if (!collaborating)
		throw new ConvexError("You do not have access to this case.");
	if (need === "edit" && collaborating.access !== "edit")
		throw new ConvexError("You have view-only access to this case.");
}

// Loads a case and checks the admin may access it, throwing if it is missing or off limits.
export async function loadCaseForAccess(
	ctx: QueryCtx | MutationCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
	need: CollaboratorAccess = "edit",
): Promise<Doc<"cases">> {
	const c = await ctx.db.get("cases", caseId);
	if (!c) throw new ConvexError("Case not found.");
	await requireCaseAccess(ctx, c, admin, need);
	return c;
}

export type CaseSummary = {
	_id: Id<"cases">;
	name: string;
	accessCode: string;
	isTemplate: boolean;
	canEdit: boolean;
};

// Reduces a case document to its id, name, access code, template flag and whether the viewer may edit it.
function toCaseSummary(c: Doc<"cases">, canEdit: boolean): CaseSummary {
	return {
		_id: c._id,
		name: c.name,
		accessCode: c.accessCode,
		isTemplate: c.isTemplate,
		canEdit,
	};
}

// Lists the cases an admin can see by name: all for a super admin, otherwise owned plus collaborating.
export async function listCases(
	ctx: QueryCtx,
	admin: Doc<"admins">,
): Promise<CaseSummary[]> {
	if (admin.role === "super") {
		const all = await ctx.db.query("cases").collect();
		return all
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((c) => toCaseSummary(c, true));
	}

	const owned = await ctx.db
		.query("cases")
		.withIndex("by_owner", (q) => q.eq("ownerAdminId", admin._id))
		.collect();

	const collaboratingRows = await ctx.db
		.query("collaborators")
		.withIndex("by_admin", (q) => q.eq("adminId", admin._id))
		.collect();
	const collaboratingCases = await Promise.all(
		collaboratingRows.map((row) => ctx.db.get("cases", row.caseId)),
	);

	const byId = new Map<Id<"cases">, CaseSummary>();
	for (const c of owned) byId.set(c._id, toCaseSummary(c, true));
	collaboratingRows.forEach((row, i) => {
		const c = collaboratingCases[i];
		if (c) byId.set(c._id, toCaseSummary(c, row.access === "edit"));
	});

	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Lists the cases an admin can copy as a template by name: the ones they can see plus every flagged template, without access codes.
export async function listTemplateChoices(
	ctx: QueryCtx,
	admin: Doc<"admins">,
): Promise<Pick<CaseSummary, "_id" | "name">[]> {
	const visible = await listCases(ctx, admin);
	const templates = await ctx.db
		.query("cases")
		.withIndex("by_is_template", (q) => q.eq("isTemplate", true))
		.collect();
	const byId = new Map<Id<"cases">, string>();
	for (const c of [...visible, ...templates]) byId.set(c._id, c.name);
	return Array.from(byId, ([_id, name]) => ({ _id, name })).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

// Deletes a case along with its file links and collaborators, without an access check.
export async function deleteCaseUnchecked(
	ctx: MutationCtx,
	caseId: Id<"cases">,
): Promise<void> {
	await syncCaseFiles(ctx, caseId, new Set());
	await replaceCollaborators(ctx, caseId, []);
	await ctx.db.delete(caseId);
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

// Validates the graph, drops file references whose upload is gone and returns the cleaned structure plus the storage ids it uses.
export async function buildStructure(
	ctx: QueryCtx,
	structure: CaseStructure,
): Promise<{ structure: CaseStructure; storageIds: Set<Id<"_storage">> }> {
	const { personas, referrals, roots } = structure;
	validateGraph(personas, referrals, roots);
	const present = await existingStorageIds(
		ctx,
		personas.flatMap((persona) => [
			persona.profilePhoto,
			...persona.files.map((entry) => entry.file),
		]),
	);
	return cleanStructure(structure, present);
}

// Dedupes collaborators by admin and rejects the owner, unknown admins and super admins.
async function resolveCollaborators(
	ctx: MutationCtx,
	collaborators: CollaboratorPayload[],
	ownerAdminId: Id<"admins">,
): Promise<CollaboratorPayload[]> {
	const byAdmin = new Map(collaborators.map((c) => [c.adminId, c]));
	const ids = [...byAdmin.keys()];
	if (ids.length === 0) return [];
	if (ids.includes(ownerAdminId)) {
		throw new ConvexError(
			"The case owner cannot also be listed as a collaborator.",
		);
	}
	const admins = await Promise.all(ids.map((id) => ctx.db.get("admins", id)));
	const missing = ids.filter((_, i) => admins[i] === null);
	if (missing.length > 0)
		throw new ConvexError(`Unknown admin id(s): ${missing.join(", ")}`);
	if (
		admins.some(
			(admin) => admin && !isSelectableCollaborator(admin, ownerAdminId),
		)
	) {
		throw new ConvexError("Super admins cannot be added as collaborators.");
	}
	return [...byAdmin.values()];
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

// Trims an access code and checks no other case uses it, allowing the case being edited to keep its own.
async function ensureAccessCodeFree(
	ctx: QueryCtx | MutationCtx,
	accessCode: string,
	excludeCaseId?: Id<"cases">,
): Promise<string> {
	const normalized = accessCode.trim();
	const existing = await ctx.db
		.query("cases")
		.withIndex("by_access_code", (q) => q.eq("accessCode", normalized))
		.first();
	if (existing !== null && existing._id !== excludeCaseId) {
		throw new ConvexError(ACCESS_CODE_CONFLICT);
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
		if (access === undefined) await ctx.db.delete(row._id);
		else if (row.access !== access) await ctx.db.patch(row._id, { access });
	}
	for (const [adminId, access] of desired) {
		if (!existingAdminIds.has(adminId)) {
			await ctx.db.insert("collaborators", { caseId, adminId, access });
		}
	}
}

// Validates and normalizes a create/update payload into the fields, collaborators and files to store.
async function resolveCasePayload(
	ctx: MutationCtx,
	payload: CasePayload,
	ownerAdminId: Id<"admins">,
	excludeCaseId?: Id<"cases">,
): Promise<{
	fields: {
		name: string;
		brief: string;
		commonInformation: string;
		accessCode: string;
		duration: number | undefined;
		structure: CaseStructure;
		teachingNotes: Exclude<FileRefPayload, null> | undefined;
	};
	collaborators: CollaboratorPayload[];
	storageIds: Set<Id<"_storage">>;
}> {
	const firstError = Object.values(
		getCaseInfoErrors({
			caseName: payload.name,
			initialBrief: payload.brief,
			accessCode: payload.accessCode,
			simulationDurationMinutes: payload.duration ?? null,
		}),
	)[0];
	if (firstError) throw new ConvexError(firstError);

	const name = payload.name.trim();
	const brief = payload.brief.trim();
	const commonInformation = payload.commonInformation.trim();
	const accessCode = await ensureAccessCodeFree(
		ctx,
		payload.accessCode,
		excludeCaseId,
	);
	const duration = payload.duration;
	const collaborators = await resolveCollaborators(
		ctx,
		payload.collaborators,
		ownerAdminId,
	);
	const { structure, storageIds } = await buildStructure(
		ctx,
		payload.structure,
	);
	const notesPresent = await existingStorageIds(ctx, [
		payload.teachingNotes ?? null,
	]);
	const teachingNotes =
		payload.teachingNotes && notesPresent.has(payload.teachingNotes.storageId)
			? payload.teachingNotes
			: undefined;
	if (teachingNotes) storageIds.add(teachingNotes.storageId);
	return {
		fields: {
			name,
			brief,
			commonInformation,
			accessCode,
			duration,
			structure,
			teachingNotes,
		},
		collaborators,
		storageIds,
	};
}

// Creates a case owned by the admin, with its collaborators and file links.
export async function createCase(
	ctx: MutationCtx,
	payload: CasePayload,
	admin: Doc<"admins">,
): Promise<Id<"cases">> {
	const { fields, collaborators, storageIds } = await resolveCasePayload(
		ctx,
		payload,
		admin._id,
	);

	const caseId = await ctx.db.insert("cases", {
		...fields,
		ownerAdminId: admin._id,
		isTemplate: false,
	});

	await replaceCollaborators(ctx, caseId, collaborators);
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
	const c = await loadCaseForAccess(ctx, caseId, admin);

	const { fields, collaborators, storageIds } = await resolveCasePayload(
		ctx,
		payload,
		c.ownerAdminId,
		caseId,
	);

	await ctx.db.patch(caseId, fields);

	await replaceCollaborators(ctx, caseId, collaborators);
	await syncCaseFiles(ctx, caseId, storageIds);
}
