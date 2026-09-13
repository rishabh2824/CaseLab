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
		.withIndex("by_case_and_admin", (q) =>
			q.eq("caseId", c._id).eq("adminId", admin._id),
		)
		.first();
	if (!collaborating)
		throw new ConvexError("You do not have access to this case.");
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
	if (!c) throw new ConvexError("Case not found.");
	await requireCaseAccess(ctx, c, admin);
	return c;
}

// What the case picker (TemplatePicker.svelte) actually shows per row -- not the full
// document. `structure` alone can run tens of KB per case (every persona's known_facts,
// personality_traits, file refs, ...), and this is a live query: Convex re-pushes a case's
// entire result the moment ANY field on ANY case in the list changes, including a field
// nothing here displays. Trimming the shape trims both what goes over the wire on first load
// and what gets re-sent on every unrelated edit.
export type CaseSummary = {
	_id: Id<"cases">;
	name: string;
	accessCode: string | undefined;
};

function toCaseSummary(c: Doc<"cases">): CaseSummary {
	return { _id: c._id, name: c.name, accessCode: c.accessCode };
}

// SUPER admins see every case; everyone else sees only cases they own or collaborate on.
// Sorted by name.
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
		collaboratingRows.map((row) => ctx.db.get(row.caseId)),
	);

	const byId = new Map<Id<"cases">, Doc<"cases">>();
	for (const c of owned) byId.set(c._id, c);
	for (const c of collaboratingCases) if (c) byId.set(c._id, c);

	return Array.from(byId.values())
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(toCaseSummary);
}

// The actual deletion work -- caseFiles/collaborators cleanup plus the case document itself --
// shared by deleteCase below (which checks the caller has access to caseId first) and
// deleteAdminWithCascade (services/admins.ts), whose cascade already runs entirely under
// requireSuperAdmin and is deleting a case the admin BEING removed owned, not one the calling
// super admin themselves asked to delete -- so there's no second per-case access check to run
// there. Exported as its own function (rather than folded into deleteCase) so that call site
// can't accidentally skip the access check deleteCase performs for a case it doesn't already
// have unconditional access to.
export async function deleteCaseUnchecked(
	ctx: MutationCtx,
	caseId: Id<"cases">,
): Promise<void> {
	// syncCaseFiles (empty desired set) removes every caseFiles row pointing at this case and
	// schedules storage object + `files` row cleanup for any file that was only referenced here
	// (see services/files.ts).
	await syncCaseFiles(ctx, caseId, new Set());
	// Empty target list -- replaceCollaborators' delete-existing pass does all the work here;
	// its insert pass is a no-op over an empty array.
	await replaceCollaborators(ctx, caseId, []);
	await ctx.db.delete(caseId);
}

export async function deleteCase(
	ctx: MutationCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
): Promise<void> {
	await loadCaseForAccess(ctx, caseId, admin);
	await deleteCaseUnchecked(ctx, caseId);
}

// A persona id doubles as a Convex record key: a run's `unlockedAt` and `personaChatState`
// are `v.record()`s keyed by persona id, and Convex rejects a field name that is empty,
// starts with "$", or contains anything outside non-control ASCII. Ids are not minted
// server-side -- the authoring UI generates UUIDs, and importCase.ts now mints a fresh UUID
// per persona on import rather than trusting whatever sat in the uploaded HTML file's
// `data-persona-id` attributes -- but that attribute is still untrusted input in principle
// (a hand-edited export, or a client bypassing the UI entirely), so an unusable id still has
// to be rejected here, at save time. Otherwise the case saves fine (`structure` is validated
// against caseStructureValidator, which constrains shape but not this id-format rule) and
// then dies mid-run, on whichever turn first tries to record state against that persona, with
// an opaque validator error and no way for the student to recover.
//
// Restricted to `[A-Za-z0-9_.-]` (a strict subset of the Convex-record-key requirement above,
// and one every UUID -- plus the older, non-UUID id shapes dataIntegrity.test.ts pins as still
// accepted -- already satisfies) rather than "anything printable and non-`$`": a wider charset
// let a persona id carry `"`, `<`, or `/` -- which exportCase.ts writes straight into an HTML
// attribute (and, for the case's fixed root id, into an inline `<script>` block) when an admin
// exports a template. A collaborator on the case (who can save personas but doesn't control
// what gets rendered when someone else exports it) could use a direct API call to plant an id
// like `"><script>...` and have it execute in whichever other admin's browser opens that
// exported file. `.` stays allowed -- it's inert in both an HTML attribute and a JS string
// literal, so it was never part of the actual risk. exportCase.ts's own escaping (below) is a
// second, independent line of defense for ids already stored under the old, wider format --
// this is the one that stops a new id like that from ever being saved at all.
const PERSONA_ID_FORMAT = /^[A-Za-z0-9_.-]+$/;

function validatePersonaId(id: string): void {
	if (!PERSONA_ID_FORMAT.test(id)) {
		throw new ConvexError(
			`Invalid persona id: ${JSON.stringify(id)}. A persona id must contain only letters, digits, hyphens, underscores, and periods.`,
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

	// Every persona needs a name and a role to be usable in a run (a nameless/roleless persona
	// has nothing for the LLM prompt or the student-facing contact list to show) -- the client
	// form already requires both (PersonaFields.svelte's `required` inputs), but that's UI, not
	// a validation boundary, same as validateRequiredText's case-name/brief check below.
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
		// A repeated (from_id, to_id) pair can't come from the authoring UI (it only ever adds
		// one referral edge per "+ Add referral" click, each to a brand-new persona) but can
		// arrive via a hand-edited import or a direct API call -- and PersonaFields.svelte's
		// `{#each ownReferrals as referral (referral.to_id)}` keys on exactly this pair, so a
		// duplicate would break Svelte's keyed reconciliation the next time this case is loaded
		// into the editor.
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

// The inverse of resolveFileRefs' extra `fileId` field -- the persisted structure blob's file
// refs (fileRefValidator, models/cases.ts) carry only storage_id/file_name/content_type, a
// closed shape Convex's own object validators reject extra fields against, so the bookkeeping
// field resolveFileRefs added has to come back off before this is written into `structure`.
function toFileRefPayload(resolved: ResolvedFileRef | null): FileRefPayload {
	if (resolved === null) return null;
	const { fileId: _fileId, ...ref } = resolved;
	return ref;
}

// Validates the graph, resolves every persona's profile photo + attachments in one batched
// resolveFileRefs call, then reassembles the structure blob with the resolved refs. Returns
// the resolved file id set alongside the structure so the caller can reconcile `caseFiles`
// via syncCaseFiles.
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
			// Known, deliberate tradeoff, not a bug: a file entry with no attachment (the
			// admin added the slot -- or imported one as a placeholder, see importCase.ts --
			// but never attached a file to it) is dropped here silently, taking its
			// share_conditions/perceived_contents text with it. This can only lose data on a
			// SUCCESSFUL save (uploads/failed saves are a separate concern -- see
			// discardUploads in api/uploads.ts); the alternative (rejecting the save, or
			// persisting a fileless entry the rest of the app has to treat as never-usable)
			// was judged worse than an admin occasionally losing an empty slot's text by
			// forgetting to attach something before submitting.
			if (!entry.file) return [];
			const resolvedFile = lookup(entry.file);
			if (resolvedFile) fileIds.add(resolvedFile.fileId);
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
			// Trimmed on the way into storage -- validateGraph above already rejects a
			// name/role that's blank once trimmed, so this just makes the stored value match
			// what was actually validated instead of persisting untrimmed surrounding
			// whitespace, same as validateRequiredText does for the case's own name/brief.
			name: persona.name.trim(),
			role: persona.role.trim(),
			profile_photo: toFileRefPayload(profilePhoto),
			known_facts: persona.known_facts,
			personality_traits: persona.personality_traits,
			availability_minutes: persona.availability_minutes,
			files,
		};
	});

	// referrals/roots are used as-is, not copied field-by-field: Convex's own argument
	// validator (casePayloadArgs, api/cases.ts) already constrains both to exactly this shape
	// before this function ever runs, so a defensive remapping here would just be reproducing
	// what already happened at the API boundary.
	return {
		structure: {
			personas: outPersonas,
			referrals,
			roots,
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
		throw new ConvexError(
			"The case owner cannot also be listed as a collaborator.",
		);
	}
	const admins = await Promise.all(deduped.map((id) => ctx.db.get(id)));
	const missing = deduped.filter((_, i) => admins[i] === null);
	if (missing.length > 0)
		throw new ConvexError(`Unknown admin id(s): ${missing.join(", ")}`);
	if (admins.some((admin) => admin?.role === "super")) {
		throw new ConvexError("Super admins cannot be added as collaborators.");
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
	accessCode: string;
	personas: PersonaPayload[];
	referrals: ReferralEdgePayload[];
	roots: string[];
	collaboratorAdminIds: Id<"admins">[];
};

// The client form already requires these (CaseInfoFields.svelte's `required` inputs), but
// that's UI, not a validation boundary -- see validateDuration's own comment on the same
// point below. A direct Convex call (or a bug upstream of submitCase.ts) could otherwise
// create a nameless, briefless case with nothing to catch it.
function validateRequiredText(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new ConvexError(`${label} is required.`);
	return trimmed;
}

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
		throw new ConvexError(
			`Simulation duration must be a whole number of minutes between 1 and ${RUN_LIFETIME_MINUTES}.`,
		);
	}
	return duration;
}

// Normalizes + validates an access code for create/update alike: required, then format, then
// uniqueness (excluding the case being updated, if any, so a case keeping its own code doesn't
// self-conflict). Every case must have one -- a case with no code can never be launched
// (startSimulation looks a run up by accessCode alone), so this is a required field, same as
// name/brief above, not merely a validated-if-present one.
async function validateAccessCode(
	ctx: QueryCtx | MutationCtx,
	accessCode: string | undefined,
	excludeCaseId?: Id<"cases">,
): Promise<string> {
	const normalized = normalizeAccessCode(accessCode);
	if (!normalized) throw new ConvexError("Access code is required.");
	if (!ACCESS_CODE_FORMAT.test(normalized)) {
		throw new ConvexError("Access code must contain only lowercase letters.");
	}
	if (await isAccessCodeTaken(ctx, normalized, excludeCaseId)) {
		throw new ConvexError(ACCESS_CODE_CONFLICT);
	}
	return normalized;
}

// Diffs against the existing rows instead of delete-all/insert-all -- a collaborator kept
// across the save retains its original row (and `addedAt`), and only admins actually being
// added or removed touch the table at all. deleteAdminWithCascade (services/admins.ts)
// sorts by `addedAt` to pick the longest-standing collaborator as a case's new owner when
// the current owner is deleted -- delete-and-reinsert on every save used to reset that
// timestamp to "whenever this case was last saved," making that choice arbitrary rather
// than actually "longest-standing." A no-op both ways when called from createCase, since a
// brand-new case has no existing rows yet.
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

// Shared by createCase and updateCase below -- validate (name, brief, access code, duration),
// resolve (collaborator ids, persona/referral graph -> structure + referenced file ids) is
// identical between the two; only what happens with the result (insert vs. patch, and
// whether an existing case's owner/access-code-exclusion applies) differs, which each caller
// still does itself. `fields` is exactly the shape each caller spreads straight into its own
// ctx.db.insert/patch call, so neither has to re-list every scalar by hand just to pass it
// along.
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
	// Optional (unlike name/brief), so trimmed rather than run through
	// validateRequiredText -- an admin who never fills this in stays that way, but
	// whatever they do type is stored without surrounding whitespace, same as every
	// other free-text field here.
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

	// The owner never changes via update -- only personas/referrals/collaborators/scalars do,
	// which is exactly what `fields` carries (no ownerAdminId in it).
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
