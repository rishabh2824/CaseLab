import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// String literals since Convex has no enum type and this is read at every authorization
// check.
export const adminRole = v.union(v.literal("super"), v.literal("admin"));
export type AdminRole = "super" | "admin";

// The cap on how long a run can live even when a case sets no duration -- also the upper
// bound a case's own `duration` is validated against at save time (services/cases.ts) and
// CaseForm.svelte's authoring input: a duration a run can never actually reach would leave
// the student's countdown still running when the run is deleted underneath it. Lives here,
// not services/simulations.ts, so the frontend can import it directly -- that module pulls
// in Convex-only side effects (the rate-limiter component, `_generated/api`) that can't be
// bundled into the browser.
export const RUN_LIFETIME_MINUTES = 120;

// The chat composer's word cap, enforced both by the Send button (disabled client-side, no
// round-trip) and by startTurn's server-side rejection (services/turn.ts) -- the same message
// can't be allowed by one and rejected by the other. Lives here, not services/turn.ts, for the
// same reason as RUN_LIFETIME_MINUTES above: turn.ts pulls in Convex-only side effects
// (`_generated/api`, rate-limiter component) that can't be bundled into the browser, so the
// frontend needs a side-effect-free source to import from.
export const MAX_MESSAGE_WORDS = 50;

const chatState = v.object({
	warningCount: v.number(),
	ended: v.boolean(),
	endReason: v.optional(v.string()),
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

	// `structure` stays a JSON blob (personas/referrals/roots) -- max observed size 15.7 KB,
	// far under Convex's 1 MiB document limit, so splitting it into per-persona documents buys
	// nothing. `accessCode`, when set, is validated to `^[a-z]+$` in the case create/update
	// mutations (services/cases.ts) so it's canonical by construction -- no second normalized
	// column needed.
	//
	// No `version`/optimistic-concurrency counter -- a deliberate simplification, not an
	// oversight. Two admins editing the same case at once is rare enough that last-write-wins
	// (whichever updateCase call runs last simply overwrites) is an acceptable outcome,
	// avoiding expected-version checks, 409 conflict responses, and a client-side
	// polling/reload UI for a scenario this rare.
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
		storageId: v.id("_storage"),
		name: v.string(),
		contentType: v.optional(v.string()),
	}).index("by_storage_id", ["storageId"]),

	// This join table makes "is this file still referenced by any case" an indexed lookup
	// instead of a full scan, which is also what makes real file deletion cheap enough to do
	// unconditionally.
	caseFiles: defineTable({
		caseId: v.id("cases"),
		fileId: v.id("files"),
	})
		.index("by_case", ["caseId"])
		.index("by_file", ["fileId"]),

	// No `snapshot` field: a run stores only `caseId` and reads the case live.
	// updateCase/deleteCase (services/cases.ts) and deleteAdminWithCascade
	// (services/admins.ts) don't block on live runs to protect this -- an accepted
	// tradeoff: editing/deleting a case out from under a live run is rare, and the admin doing
	// it is assumed to know the consequences. The read paths (services/simulationReads.ts,
	// services/turn.ts) fail cleanly rather than crash if the case (or a persona in its
	// structure) has changed or disappeared underneath a run -- see runLifecycle.test.ts's
	// "a run whose case was somehow removed reports a case error, not a crash".
	runs: defineTable({
		caseId: v.id("cases"),
		startTime: v.number(),
		expiresAt: v.number(),
		activePersonaKey: v.string(),
		unlockedReferredIds: v.array(v.string()),
		unlockedAt: v.record(v.string(), v.number()),
		// Which files (by `files` row id) have been shared into this run -- just the id, not a
		// name/contentType/storageId snapshot. Case edits/deletes are assumed never to happen
		// against a live run (see runs' own comment above), so there's no risk of the referenced
		// `files` row changing out from under an active simulation; getSimulationState resolves
		// the current name/contentType/storageId live off this id instead of carrying a copy.
		sharedFiles: v.array(v.id("files")),
		personaChatState: v.record(v.string(), chatState),
		// The scheduled-function id for this run's expiry deletion (see
		// convex/runs.ts's `destroy`), so it can be cancelled/rescheduled if needed.
		// Optional only during the brief window between insert and the scheduler
		// call returning.
		destroyJobId: v.optional(v.id("_scheduled_functions")),
	}).index("by_expiry", ["expiresAt"]),

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
		status: v.union(
			v.literal("streaming"),
			v.literal("done"),
			v.literal("error"),
		),
		// Refreshed on every write to this row (claim, preview flush, terminal patch) -- lets
		// claimStreamingSlot (services/turn.ts) tell "still generating" apart from "the process
		// that was generating this died" for a row stuck at status "streaming", instead of
		// treating every "streaming" row as permanently in flight. See claimStreamingSlot's own
		// comment for why a killed action can otherwise strand this row until the run itself
		// expires.
		updatedAt: v.number(),
	}).index("by_run_persona", ["runId", "personaKey"]),
});
