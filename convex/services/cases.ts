import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type {
	CaseStructure,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload,
} from "../models/cases";
import { RUN_LIFETIME_MINUTES } from "../schema";
import { type ResolvedFileRef, resolveFileRefs, syncCaseFiles } from "./files";

const ACCESS_CODE_CONFLICT =
	"An access code with this value already exists on another case.";
// Convex has no case-insensitive column type, so codes are constrained to lowercase letters
// at write time instead, making storage canonical by construction.
const ACCESS_CODE_FORMAT = /^[a-z]+$/;

// SUPER admins bypass everything, the owner always has access, otherwise the admin must be
// a collaborator.
export async function requireCaseAccess(
	ctx: QueryCtx | MutationCtx,
	c: Doc<"cases">,
	admin: Doc<"admins">,
): Promise<void> {
	if (admin.role === "super") return;
	if (c.ownerAdminId === admin._id) return;
	const collaborating = await ctx.db
		.query("collaborators")
		.withIndex("by_case", (q) => q.eq("caseId", c._id))
		.filter((q) => q.eq(q.field("adminId"), admin._id))
		.first();
	if (!collaborating) throw new Error("You do not have access to this case.");
}

// The "load a case the caller is allowed to see, or fail" idiom every case-scoped handler
// needs before it can do anything else -- get, getForEdit, deleteCase, and updateCase all
// used to repeat these three lines by hand, and one of the four copies (api/cases.ts's
// `get`) quietly returned null on a missing case instead of throwing like the rest.
export async function loadCaseForAccess(
	ctx: QueryCtx | MutationCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
): Promise<Doc<"cases">> {
	const c = await ctx.db.get(caseId);
	if (!c) throw new Error("Case not found.");
	await requireCaseAccess(ctx, c, admin);
	return c;
}

// SUPER admins see every case; everyone else sees only cases they own or collaborate on.
// Sorted by name.
export async function listCases(
	ctx: QueryCtx,
	admin: Doc<"admins">,
): Promise<Doc<"cases">[]> {
	if (admin.role === "super") {
		const all = await ctx.db.query("cases").collect();
		return all.sort((a, b) => a.name.localeCompare(b.name));
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
		collaboratingRows.map((row) => ctx.db.get(row.caseId)),
	);

	const byId = new Map<Id<"cases">, Doc<"cases">>();
	for (const c of owned) byId.set(c._id, c);
	for (const c of collaboratingCases) if (c) byId.set(c._id, c);

	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// syncCaseFiles (empty desired set) removes every caseFiles row pointing at this case and
// schedules storage object + `files` row cleanup for any file that was only referenced here
// (see services/files.ts).
export async function deleteCase(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
): Promise<void> {
	await loadCaseForAccess(ctx, caseId, admin);

	await syncCaseFiles(ctx, caseId, new Set());
	// Empty target list -- replaceCollaborators' delete-existing pass does all the work here;
	// its insert pass is a no-op over an empty array.
	await replaceCollaborators(ctx, caseId, []);
	await ctx.db.delete(caseId);
}

// A persona id doubles as a Convex record key: a run's `unlockedAt` and `personaChatState`
// are `v.record()`s keyed by persona id, and Convex rejects a field name
// that is empty, starts with "$", or contains anything outside non-control ASCII. Ids are not
// minted server-side -- the authoring UI generates UUIDs, but importCase.ts reads them straight
// out of an uploaded HTML case file's `data-persona-id` attributes, which is untrusted input --
// so an unusable id has to be rejected here, at save time. Otherwise the case saves fine
// (`structure` is `v.any()`) and then dies mid-run, on whichever turn first tries to record
// state against that persona, with an opaque validator error and no way for the student to
// recover.
const PERSONA_ID_FORMAT = /^[\x20-\x7e]+$/;

function validatePersonaId(id: string): void {
	if (!PERSONA_ID_FORMAT.test(id) || id.startsWith("$")) {
		throw new Error(
			`Invalid persona id: ${JSON.stringify(id)}. A persona id must be non-empty printable ASCII and must not start with "$".`,
		);
	}
}

// The flat persona/referral graph a save is about to write must have usable, unique persona
// ids, roots/referral endpoints that all point at real personas, at least one root, and no
// referral cycle.
export function validateGraph(
	personas: PersonaPayload[],
	referrals: ReferralEdgePayload[],
	roots: string[],
): void {
	// A case with no personas, or with personas but no root, can never be simulated:
	// startSimulation (services/simulations.ts) rejects it as "This case has no personas
	// configured." Failing at save time instead means the admin finds out while they're still
	// looking at the editor, rather than a student finding out at the access-code screen.
	if (personas.length === 0)
		throw new Error("A case needs at least one persona.");
	if (roots.length === 0) {
		throw new Error("A case needs at least one root persona to start from.");
	}

	const personaIds = personas.map((p) => p.id);
	for (const id of personaIds) validatePersonaId(id);
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const id of personaIds) (seen.has(id) ? duplicates : seen).add(id);
	if (duplicates.size > 0) {
		throw new Error(
			`Duplicate persona id(s): ${[...duplicates].sort().join(", ")}`,
		);
	}

	const validIds = seen;
	for (const rootId of roots) {
		if (!validIds.has(rootId))
			throw new Error(`Unknown root persona id: ${rootId}`);
	}
	for (const referral of referrals) {
		if (!validIds.has(referral.from_id))
			throw new Error(`Unknown referral from_id: ${referral.from_id}`);
		if (!validIds.has(referral.to_id))
			throw new Error(`Unknown referral to_id: ${referral.to_id}`);
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

	// Three-colour DFS, iterative rather than recursive: a long referral chain is a perfectly
	// legal case shape and trivially produced by an imported file, and recursing once per node
	// blew the stack (RangeError) at a few thousand personas -- which surfaced as an
	// unexplainable save failure rather than a validation message. The explicit stack holds
	// (node, next-neighbour-index) so a node is only marked DONE once all of its edges have been
	// walked, exactly as the recursive version did on return.
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
				throw new Error(
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

function toFileRefInput(ref: FileRefPayload | undefined) {
	return ref
		? {
				storageId: ref.storage_id,
				fileName: ref.file_name,
				contentType: ref.content_type ?? undefined,
			}
		: null;
}

// The inverse of toFileRefInput, in the structure blob's snake_case shape (see
// models/cases.ts).
function toStructureFileRef(resolved: ResolvedFileRef | null): FileRefPayload {
	if (resolved === null) return null;
	return {
		storage_id: resolved.storageId,
		file_name: resolved.fileName,
		content_type: resolved.contentType,
	};
}

// Validates the graph, resolves every persona's profile photo + attachments in one batched
// resolveFileRefs call (fixed order: each persona's photo, then each of its file entries),
// then reassembles the structure blob with the resolved refs. Returns the resolved file id
// set alongside the structure so the caller can reconcile `caseFiles` via syncCaseFiles.
export async function buildStructure(
	ctx: MutationCtx,
	personas: PersonaPayload[],
	referrals: ReferralEdgePayload[],
	roots: string[],
): Promise<{ structure: CaseStructure; fileIds: Set<Id<"files">> }> {
	validateGraph(personas, referrals, roots);

	const fileRefs = personas.flatMap((persona) => [
		toFileRefInput(persona.profile_photo),
		...(persona.files ?? []).map((entry) => toFileRefInput(entry.file)),
	]);
	const resolved = await resolveFileRefs(ctx, fileRefs);
	let cursor = 0;

	const fileIds = new Set<Id<"files">>();
	const outPersonas = personas.map((persona) => {
		const profilePhoto = resolved[cursor++] ?? null;
		if (profilePhoto) fileIds.add(profilePhoto.fileId);

		const files = (persona.files ?? [])
			.map((entry) => {
				const resolvedFile = resolved[cursor++] ?? null;
				if (!entry.file) return null; // dropped
				if (resolvedFile) fileIds.add(resolvedFile.fileId);
				return {
					file: toStructureFileRef(resolvedFile),
					share_conditions: entry.share_conditions,
					perceived_contents: entry.perceived_contents,
				};
			})
			.filter((entry) => entry !== null);

		return {
			id: persona.id,
			name: persona.name,
			role: persona.role,
			profile_photo: toStructureFileRef(profilePhoto),
			known_facts: persona.known_facts,
			personality_traits: persona.personality_traits,
			availability_minutes: persona.availability_minutes,
			files,
		};
	});

	const outReferrals = referrals.map((r) => ({
		from_id: r.from_id,
		to_id: r.to_id,
		conditions: r.conditions,
	}));

	return {
		structure: {
			personas: outPersonas,
			referrals: outReferrals,
			roots: [...roots],
		},
		fileIds,
	};
}

function normalizeAccessCode(
	accessCode: string | undefined,
): string | undefined {
	const trimmed = accessCode?.trim();
	return trimmed ? trimmed : undefined;
}

async function isAccessCodeTaken(
	ctx: QueryCtx | MutationCtx,
	accessCode: string,
	excludeCaseId?: Id<"cases">,
): Promise<boolean> {
	const existing = await ctx.db
		.query("cases")
		.withIndex("by_access_code", (q) => q.eq("accessCode", accessCode))
		.first();
	return existing !== null && existing._id !== excludeCaseId;
}

// Dedupes, rejects the case owner appearing in their own collaborator list, rejects unknown
// admin ids, and rejects SUPER admins (they already have full access everywhere).
async function resolveCollaboratorIds(
	ctx: MutationCtx,
	ids: Id<"admins">[],
	ownerAdminId: Id<"admins">,
): Promise<Id<"admins">[]> {
	const deduped = [...new Set(ids)];
	if (deduped.length === 0) return [];
	if (deduped.includes(ownerAdminId)) {
		throw new Error("The case owner cannot also be listed as a collaborator.");
	}
	const admins = await Promise.all(deduped.map((id) => ctx.db.get(id)));
	const missing = deduped.filter((_, i) => admins[i] === null);
	if (missing.length > 0)
		throw new Error(`Unknown admin id(s): ${missing.join(", ")}`);
	if (admins.some((admin) => admin?.role === "super")) {
		throw new Error("Super admins cannot be added as collaborators.");
	}
	return deduped;
}

// Shared by createCase and updateCase -- the only difference between the two mutations is
// what happens before/after this data and whether an existing case is involved at all.
export type CasePayload = {
	name: string;
	brief: string;
	commonInformation?: string;
	duration?: number;
	accessCode?: string;
	personas: PersonaPayload[];
	referrals: ReferralEdgePayload[];
	roots: string[];
	collaboratorAdminIds: Id<"admins">[];
};

// The 1..RUN_LIFETIME_MINUTES bound previously lived only in CaseForm.svelte's `max` attribute,
// which is not a validation boundary -- a direct Convex call, or a paste past the input's max,
// persisted anything. Each rejected value below is genuinely broken, not merely odd:
//   * <= 0 makes startTurn's `elapsed >= c.duration` true on the very first turn, so every
//     message is refused as "This simulation has ended." and the case is silently unusable;
//   * a fraction can't be compared meaningfully against whole elapsed minutes;
//   * anything past RUN_LIFETIME_MINUTES is unreachable -- computeExpiresAt caps a run's actual
//     life there, while the student's countdown (run.svelte.ts) is driven by this number, so the
//     clock would still read "time remaining" at the moment the run is deleted underneath them.
function validateDuration(duration: number | undefined): number | undefined {
	if (duration === undefined) return undefined;
	if (
		!Number.isInteger(duration) ||
		duration < 1 ||
		duration > RUN_LIFETIME_MINUTES
	) {
		throw new Error(
			`Simulation duration must be a whole number of minutes between 1 and ${RUN_LIFETIME_MINUTES}.`,
		);
	}
	return duration;
}

// Normalizes + validates an access code for create/update alike: format, then uniqueness
// (excluding the case being updated, if any, so a case keeping its own code doesn't
// self-conflict).
async function validateAccessCode(
	ctx: QueryCtx | MutationCtx,
	accessCode: string | undefined,
	excludeCaseId?: Id<"cases">,
): Promise<string | undefined> {
	const normalized = normalizeAccessCode(accessCode);
	if (!normalized) return undefined;
	if (!ACCESS_CODE_FORMAT.test(normalized)) {
		throw new Error("Access code must contain only lowercase letters.");
	}
	if (await isAccessCodeTaken(ctx, normalized, excludeCaseId)) {
		throw new Error(ACCESS_CODE_CONFLICT);
	}
	return normalized;
}

// Replace-all, same convention as `structure` -- not an incremental diff. A no-op delete
// loop when called from createCase, since a brand-new case has no existing rows yet.
async function replaceCollaborators(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	collaboratorIds: Id<"admins">[],
): Promise<void> {
	const existing = await ctx.db
		.query("collaborators")
		.withIndex("by_case", (q) => q.eq("caseId", caseId))
		.collect();
	for (const row of existing) await ctx.db.delete(row._id);
	for (const adminId of collaboratorIds) {
		await ctx.db.insert("collaborators", {
			caseId,
			adminId,
			addedAt: Date.now(),
		});
	}
}

// Shared by createCase and updateCase below -- validate (access code, duration), resolve
// (collaborator ids, persona/referral graph -> structure + referenced file ids) is identical
// between the two; only what happens with the result (insert vs. patch, and whether an
// existing case's owner/access-code-exclusion applies) differs, which each caller still does
// itself.
async function resolveCasePayload(
	ctx: MutationCtx,
	payload: CasePayload,
	ownerAdminId: Id<"admins">,
	excludeCaseId?: Id<"cases">,
): Promise<{
	accessCode: string | undefined;
	duration: number | undefined;
	collaboratorIds: Id<"admins">[];
	structure: CaseStructure;
	fileIds: Set<Id<"files">>;
}> {
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
	return { accessCode, duration, collaboratorIds, structure, fileIds };
}

export async function createCase(
	ctx: MutationCtx,
	payload: CasePayload,
	admin: Doc<"admins">,
): Promise<Id<"cases">> {
	const { accessCode, duration, collaboratorIds, structure, fileIds } =
		await resolveCasePayload(ctx, payload, admin._id);

	const caseId = await ctx.db.insert("cases", {
		name: payload.name,
		brief: payload.brief,
		commonInformation: payload.commonInformation,
		duration,
		accessCode,
		ownerAdminId: admin._id,
		structure,
	});

	await replaceCollaborators(ctx, caseId, collaboratorIds);
	await syncCaseFiles(ctx, caseId, fileIds);

	return caseId;
}

// No expected_version optimistic-concurrency check: two admins saving the same case at once
// is rare enough that last-write-wins is an accepted tradeoff here (see schema.ts's comment
// on `cases`). syncCaseFiles diffs the case's caseFiles rows against buildStructure's
// resolved file id set and schedules cleanup for anything dropped.
export async function updateCase(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	payload: CasePayload,
	admin: Doc<"admins">,
): Promise<void> {
	const c = await loadCaseForAccess(ctx, caseId, admin);

	// The owner never changes via update -- only personas/referrals/collaborators/scalars do.
	const { accessCode, duration, collaboratorIds, structure, fileIds } =
		await resolveCasePayload(ctx, payload, c.ownerAdminId, caseId);

	await ctx.db.patch(caseId, {
		name: payload.name,
		brief: payload.brief,
		commonInformation: payload.commonInformation,
		duration,
		accessCode,
		structure,
	});

	await replaceCollaborators(ctx, caseId, collaboratorIds);
	await syncCaseFiles(ctx, caseId, fileIds);
}
