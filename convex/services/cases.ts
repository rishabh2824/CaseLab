import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type {
	CaseStructure,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload,
} from "../models/cases";
import { ACCESS_CODE_FORMAT, RUN_LIFETIME_MINUTES } from "../schema";
import { type ResolvedFileRef, resolveFileRefs, syncCaseFiles } from "./files";

const ACCESS_CODE_CONFLICT =
	"An access code with this value already exists on another case.";

// Throws unless the admin is a super admin, the case owner or a collaborator.
export async function requireCaseAccess(
	ctx: QueryCtx | MutationCtx,
	c: Doc<"cases">,
	admin: Doc<"admins">,
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
}

// Loads a case and checks the admin may access it, throwing if it is missing or off limits.
export async function loadCaseForAccess(
	ctx: QueryCtx | MutationCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
): Promise<Doc<"cases">> {
	const c = await ctx.db.get("cases", caseId);
	if (!c) throw new ConvexError("Case not found.");
	await requireCaseAccess(ctx, c, admin);
	return c;
}

export type CaseSummary = {
	_id: Id<"cases">;
	name: string;
	accessCode: string;
};

// Reduces a case document to its id, name and access code.
function toCaseSummary(c: Doc<"cases">): CaseSummary {
	return { _id: c._id, name: c.name, accessCode: c.accessCode };
}

// Lists the cases an admin can see by name: all for a super admin, otherwise owned plus collaborating.
export async function listCases(
	ctx: QueryCtx,
	admin: Doc<"admins">,
): Promise<CaseSummary[]> {
	if (admin.role === "super") {
		const all = await ctx.db.query("cases").collect();
		return all.sort((a, b) => a.name.localeCompare(b.name)).map(toCaseSummary);
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

	const byId = new Map<Id<"cases">, Doc<"cases">>();
	for (const c of owned) byId.set(c._id, c);
	for (const c of collaboratingCases) if (c) byId.set(c._id, c);

	return Array.from(byId.values())
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(toCaseSummary);
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

const PERSONA_ID_FORMAT = /^[A-Za-z0-9_.-]+$/;

// Throws if a persona id contains characters outside letters, digits, hyphens, underscores and periods.
function validatePersonaId(id: string): void {
	if (!PERSONA_ID_FORMAT.test(id)) {
		throw new ConvexError(
			`Invalid persona id: ${JSON.stringify(id)}. A persona id must contain only letters, digits, hyphens, underscores, and periods.`,
		);
	}
}

// Validates personas, roots and referrals: required fields, unique ids, known references and no cycles.
export function validateGraph(
	personas: PersonaPayload[],
	referrals: ReferralEdgePayload[],
	roots: string[],
): void {
	if (personas.length === 0)
		throw new ConvexError("A case needs at least one persona.");
	if (roots.length === 0) {
		throw new ConvexError(
			"A case needs at least one root persona to start from.",
		);
	}

	const personaIds = personas.map((p) => p.id);
	for (const id of personaIds) validatePersonaId(id);
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const id of personaIds) (seen.has(id) ? duplicates : seen).add(id);
	if (duplicates.size > 0) {
		throw new ConvexError(
			`Duplicate persona id(s): ${[...duplicates].sort().join(", ")}`,
		);
	}

	for (const persona of personas) {
		if (!persona.name?.trim()) {
			throw new ConvexError(`Persona ${persona.id} is missing a name.`);
		}
		if (!persona.role?.trim()) {
			throw new ConvexError(`Persona ${persona.id} is missing a role.`);
		}
		if (
			persona.availability_minutes !== null &&
			persona.availability_minutes !== undefined &&
			(!Number.isInteger(persona.availability_minutes) ||
				persona.availability_minutes < 1)
		) {
			throw new ConvexError(
				`Persona ${persona.id}'s availability must be a whole number of minutes, at least 1.`,
			);
		}
	}

	const validIds = seen;
	const seenRoots = new Set<string>();
	for (const rootId of roots) {
		if (!validIds.has(rootId))
			throw new ConvexError(`Unknown root persona id: ${rootId}`);
		if (seenRoots.has(rootId)) {
			throw new ConvexError(`Duplicate root persona id: ${rootId}`);
		}
		seenRoots.add(rootId);
	}
	const seenReferrals = new Set<string>();
	for (const referral of referrals) {
		if (!validIds.has(referral.from_id))
			throw new ConvexError(`Unknown referral from_id: ${referral.from_id}`);
		if (!validIds.has(referral.to_id))
			throw new ConvexError(`Unknown referral to_id: ${referral.to_id}`);
		const referralKey = JSON.stringify([referral.from_id, referral.to_id]);
		if (seenReferrals.has(referralKey)) {
			throw new ConvexError(
				`Duplicate referral: ${referral.from_id} -> ${referral.to_id}`,
			);
		}
		seenReferrals.add(referralKey);
	}

	const adjacency = new Map<string, string[]>();
	for (const referral of referrals) {
		const targets = adjacency.get(referral.from_id) ?? [];
		targets.push(referral.to_id);
		adjacency.set(referral.from_id, targets);
	}

	const UNVISITED = 0;
	const IN_PROGRESS = 1;
	const DONE = 2;
	const state = new Map<string, number>(
		personaIds.map((id) => [id, UNVISITED]),
	);

	const stack: { node: string; edge: number }[] = [];
	for (const personaId of personaIds) {
		if (state.get(personaId) !== UNVISITED) continue;
		state.set(personaId, IN_PROGRESS);
		stack.push({ node: personaId, edge: 0 });

		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const neighbors = adjacency.get(frame.node) ?? [];
			if (frame.edge >= neighbors.length) {
				state.set(frame.node, DONE);
				stack.pop();
				continue;
			}
			const neighbor = neighbors[frame.edge]!;
			frame.edge += 1;
			if (state.get(neighbor) === IN_PROGRESS) {
				throw new ConvexError(
					`Referral cycle detected involving persona id: ${neighbor}`,
				);
			}
			if (state.get(neighbor) === UNVISITED) {
				state.set(neighbor, IN_PROGRESS);
				stack.push({ node: neighbor, edge: 0 });
			}
		}
	}
}

// Strips the internal file id from a resolved file reference.
function toFileRefPayload(resolved: ResolvedFileRef | null): FileRefPayload {
	if (resolved === null) return null;
	const { fileId: _fileId, ...ref } = resolved;
	return ref;
}

// Validates the graph, resolves its file references and returns the cleaned structure plus its file ids.
export async function buildStructure(
	ctx: MutationCtx,
	personas: PersonaPayload[],
	referrals: ReferralEdgePayload[],
	roots: string[],
): Promise<{ structure: CaseStructure; fileIds: Set<Id<"files">> }> {
	validateGraph(personas, referrals, roots);

	const fileRefs = personas.flatMap((persona) => [
		persona.profile_photo,
		...(persona.files ?? []).map((entry) => entry.file),
	]);
	const resolved = await resolveFileRefs(ctx, fileRefs);
	const lookup = (
		ref: FileRefPayload | null | undefined,
	): ResolvedFileRef | null =>
		ref ? (resolved.get(ref.storage_id) ?? null) : null;

	const fileIds = new Set<Id<"files">>();
	const outPersonas = personas.map((persona) => {
		const profilePhoto = lookup(persona.profile_photo);
		if (profilePhoto) fileIds.add(profilePhoto.fileId);

		const files = (persona.files ?? []).flatMap((entry) => {
			if (!entry.file) return [];
			const resolvedFile = lookup(entry.file);
			if (!resolvedFile) return [];
			fileIds.add(resolvedFile.fileId);
			return [
				{
					file: toFileRefPayload(resolvedFile),
					share_conditions: entry.share_conditions,
					perceived_contents: entry.perceived_contents,
				},
			];
		});

		return {
			id: persona.id,
			name: persona.name.trim(),
			role: persona.role.trim(),
			profile_photo: toFileRefPayload(profilePhoto),
			known_facts: persona.known_facts,
			personality_traits: persona.personality_traits,
			availability_minutes: persona.availability_minutes,
			files,
		};
	});

	return {
		structure: {
			personas: outPersonas,
			referrals,
			roots,
		},
		fileIds,
	};
}

// Dedupes collaborator ids and rejects the owner, unknown admins and super admins.
async function resolveCollaboratorIds(
	ctx: MutationCtx,
	ids: Id<"admins">[],
	ownerAdminId: Id<"admins">,
): Promise<Id<"admins">[]> {
	const deduped = [...new Set(ids)];
	if (deduped.length === 0) return [];
	if (deduped.includes(ownerAdminId)) {
		throw new ConvexError(
			"The case owner cannot also be listed as a collaborator.",
		);
	}
	const admins = await Promise.all(
		deduped.map((id) => ctx.db.get("admins", id)),
	);
	const missing = deduped.filter((_, i) => admins[i] === null);
	if (missing.length > 0)
		throw new ConvexError(`Unknown admin id(s): ${missing.join(", ")}`);
	if (admins.some((admin) => admin?.role === "super")) {
		throw new ConvexError("Super admins cannot be added as collaborators.");
	}
	return deduped;
}

export type CasePayload = {
	name: string;
	brief: string;
	commonInformation?: string;
	duration?: number;
	accessCode: string;
	personas: PersonaPayload[];
	referrals: ReferralEdgePayload[];
	roots: string[];
	collaboratorAdminIds: Id<"admins">[];
};

// Trims a required text field, throwing if it is blank.
function validateRequiredText(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new ConvexError(`${label} is required.`);
	return trimmed;
}

// Checks a simulation duration is a whole number of minutes within the run lifetime, if set.
function validateDuration(duration: number | undefined): number | undefined {
	if (duration === undefined) return undefined;
	if (
		!Number.isInteger(duration) ||
		duration < 1 ||
		duration > RUN_LIFETIME_MINUTES
	) {
		throw new ConvexError(
			`Simulation duration must be a whole number of minutes between 1 and ${RUN_LIFETIME_MINUTES}.`,
		);
	}
	return duration;
}

// Trims and validates an access code's format and uniqueness, allowing the case being edited to keep its own.
async function validateAccessCode(
	ctx: QueryCtx | MutationCtx,
	accessCode: string,
	excludeCaseId?: Id<"cases">,
): Promise<string> {
	const normalized = accessCode.trim();
	if (!normalized) throw new ConvexError("Access code is required.");
	if (!ACCESS_CODE_FORMAT.test(normalized)) {
		throw new ConvexError("Access code must contain only lowercase letters.");
	}
	const existing = await ctx.db
		.query("cases")
		.withIndex("by_access_code", (q) => q.eq("accessCode", normalized))
		.first();
	if (existing !== null && existing._id !== excludeCaseId) {
		throw new ConvexError(ACCESS_CODE_CONFLICT);
	}
	return normalized;
}

// Syncs a case's collaborator rows to the given admin ids, keeping existing rows intact.
async function replaceCollaborators(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	collaboratorIds: Id<"admins">[],
): Promise<void> {
	const existing = await ctx.db
		.query("collaborators")
		.withIndex("by_case", (q) => q.eq("caseId", caseId))
		.collect();
	const existingAdminIds = new Set(existing.map((row) => row.adminId));
	const desiredAdminIds = new Set(collaboratorIds);

	for (const row of existing) {
		if (!desiredAdminIds.has(row.adminId)) await ctx.db.delete(row._id);
	}
	for (const adminId of collaboratorIds) {
		if (!existingAdminIds.has(adminId)) {
			await ctx.db.insert("collaborators", {
				caseId,
				adminId,
				addedAt: Date.now(),
			});
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
		commonInformation: string | undefined;
		accessCode: string;
		duration: number | undefined;
		structure: CaseStructure;
	};
	collaboratorIds: Id<"admins">[];
	fileIds: Set<Id<"files">>;
}> {
	const name = validateRequiredText(payload.name, "Case name");
	const brief = validateRequiredText(payload.brief, "Initial brief");
	const commonInformation = payload.commonInformation?.trim();
	const accessCode = await validateAccessCode(
		ctx,
		payload.accessCode,
		excludeCaseId,
	);
	const duration = validateDuration(payload.duration);
	const collaboratorIds = await resolveCollaboratorIds(
		ctx,
		payload.collaboratorAdminIds,
		ownerAdminId,
	);
	const { structure, fileIds } = await buildStructure(
		ctx,
		payload.personas,
		payload.referrals,
		payload.roots,
	);
	return {
		fields: { name, brief, commonInformation, accessCode, duration, structure },
		collaboratorIds,
		fileIds,
	};
}

// Creates a case owned by the admin, with its collaborators and file links.
export async function createCase(
	ctx: MutationCtx,
	payload: CasePayload,
	admin: Doc<"admins">,
): Promise<Id<"cases">> {
	const { fields, collaboratorIds, fileIds } = await resolveCasePayload(
		ctx,
		payload,
		admin._id,
	);

	const caseId = await ctx.db.insert("cases", {
		...fields,
		ownerAdminId: admin._id,
	});

	await replaceCollaborators(ctx, caseId, collaboratorIds);
	await syncCaseFiles(ctx, caseId, fileIds);

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

	const { fields, collaboratorIds, fileIds } = await resolveCasePayload(
		ctx,
		payload,
		c.ownerAdminId,
		caseId,
	);

	await ctx.db.patch(caseId, fields);

	await replaceCollaborators(ctx, caseId, collaboratorIds);
	await syncCaseFiles(ctx, caseId, fileIds);
}
