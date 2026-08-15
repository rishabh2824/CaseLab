import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { adminRole } from "./models/admin";

// Mirrors backend/models/runtime.py's ChatState.
const chatState = v.object({
	warningCount: v.number(),
	ended: v.boolean(),
	endReason: v.optional(v.string()),
	lastFlagType: v.optional(v.string()),
});

// Mirrors backend/models/runtime.py's FileRecord (a shared-file entry recorded on a run).
const fileRecord = v.object({
	fileId: v.id("files"),
	fileName: v.string(),
	contentType: v.optional(v.string()),
	objectKey: v.string(),
});

export default defineSchema({
	...authTables,

	// The authorization gate — Convex Auth's `users` table (from authTables) is identity
	// only; an authenticated Google account with no matching row here is not an admin.
	admins: defineTable({
		email: v.string(),
		name: v.optional(v.string()),
		role: adminRole,
	}).index("by_email", ["email"]),

	// `structure` stays a JSON blob (personas/referrals/roots), same shape as
	// backend/models/cases.py's CaseStructure — max observed size 15.7 KB, far under
	// Convex's 1 MiB document limit, so splitting it into per-persona documents buys
	// nothing. `accessCode`, when set, is validated to `^[a-z]+$` in the case create/update
	// mutations (services/cases.ts) so it's canonical by construction — no second
	// normalized column, unlike Postgres's CITEXT-backed column today.
	//
	// No `version`/optimistic-concurrency counter, unlike Case.version in
	// backend/infra/db_models.py — a deliberate simplification, not an oversight. Two admins
	// editing the same case at once is rare enough that last-write-wins (whichever
	// updateCase call runs last simply overwrites) is an acceptable outcome, avoiding
	// expected-version checks, 409 conflict responses, and a client-side polling/reload UI
	// for a scenario this rare.
	cases: defineTable({
		name: v.string(),
		brief: v.string(),
		commonInformation: v.optional(v.string()),
		duration: v.optional(v.number()),
		accessCode: v.optional(v.string()),
		ownerAdminId: v.id("admins"),
		structure: v.any(),
	})
		.index("by_owner", ["ownerAdminId"])
		.index("by_access_code", ["accessCode"]),

	collaborators: defineTable({
		caseId: v.id("cases"),
		adminId: v.id("admins"),
		addedAt: v.number(),
	})
		.index("by_case", ["caseId"])
		.index("by_admin", ["adminId"]),

	files: defineTable({
		objectKey: v.string(),
		name: v.string(),
		contentType: v.optional(v.string()),
	}).index("by_object_key", ["objectKey"]),

	// Replaces backend/services/cases.py's referencedFileIds, which does a
	// `cast(structure, String) LIKE '%"file_id": "N"%'` scan over serialized JSONB.
	// This join table makes "is this file still referenced by any case" an indexed
	// lookup instead, which is also what makes real file deletion (closing the
	// deferred file-lifecycle leak) cheap enough to do unconditionally.
	caseFiles: defineTable({
		caseId: v.id("cases"),
		fileId: v.id("files"),
	})
		.index("by_case", ["caseId"])
		.index("by_file", ["fileId"]),

	// No `snapshot` field: a run stores only `caseId` and reads the case live. This
	// replaces backend/models/runtime.py's RunSnapshot (case_snapshot + persona_graph
	// duplicated into every run) — safe because updateCase and deleteCase (services/cases.ts)
	// both refuse to run while a case has live runs, via lib/guardNoLiveRuns.ts — enforced as
	// a real invariant via Convex's serializable mutations rather than defended against via
	// duplication.
	runs: defineTable({
		caseId: v.id("cases"),
		startTime: v.number(),
		expiresAt: v.number(),
		activePersonaKey: v.string(),
		unlockedReferredIds: v.array(v.string()),
		unlockedAt: v.record(v.string(), v.number()),
		sharedFiles: v.record(v.string(), fileRecord),
		personaChatState: v.record(v.string(), chatState),
		// The scheduled-function id for this run's expiry deletion (see
		// convex/runs.ts's `destroy`), so it can be cancelled/rescheduled if needed.
		// Optional only during the brief window between insert and the scheduler
		// call returning.
		destroyJobId: v.optional(v.id("_scheduled_functions")),
	})
		.index("by_case", ["caseId"])
		.index("by_expiry", ["expiresAt"]),

	runMessages: defineTable({
		runId: v.id("runs"),
		personaKey: v.string(),
		role: v.union(v.literal("user"), v.literal("assistant")),
		content: v.string(),
	}).index("by_run_persona", ["runId", "personaKey"]),

	// Live in-progress persona replies, batched-written by the streaming action
	// (convex/simulation/turn.ts's runTurn) and subscribed to by the frontend instead
	// of an SSE connection. Deliberately its own table, not a field on `runs`: if
	// deltas instead touched the run document, every delta would re-push the whole
	// run state (contacts, histories, etc.) to every subscriber instead of ~40 bytes
	// to the one client watching this persona's reply.
	streamingReplies: defineTable({
		runId: v.id("runs"),
		personaKey: v.string(),
		text: v.string(),
		status: v.union(v.literal("streaming"), v.literal("done"), v.literal("error")),
	}).index("by_run_persona", ["runId", "personaKey"]),
});
