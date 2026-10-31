import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { rootIds } from "../shared/caseGraph";
import { STUDENT_ERROR, studentError } from "../shared/studentErrors";
import type {
	CaseStructure,
	PersonaPayload,
	ReferralEdgePayload,
} from "../shared/validators";

export type PersonaGraph = {
	personas: Map<string, PersonaPayload>;
	referrals: ReferralEdgePayload[];
	roots: string[];
};

// Turns a case structure into a graph of personas, referral edges and name-sorted roots (the personas nobody refers to). The structure is already validated on write.
export function flattenPersonas(structure: CaseStructure): PersonaGraph {
	const personas = new Map(structure.personas.map((p) => [p.id, p]));
	const roots = rootIds(
		structure.personas.map((p) => p.id),
		structure.referrals,
	).sort((a, b) => personas.get(a)!.name.localeCompare(personas.get(b)!.name));
	return { personas, referrals: structure.referrals, roots };
}

// A persona flags at most NONSENSE_THRESHOLD messages before its chat ends, so this stays small.
const MAX_FLAGGED_TURNS = 500;

// Counts the flagged turns of each persona in a run.
export async function flaggedCounts(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<Map<string, number>> {
	const flagged = await ctx.db
		.query("turns")
		.withIndex("by_run_status", (q) =>
			q.eq("runId", runId).eq("status", "flagged"),
		)
		.take(MAX_FLAGGED_TURNS);
	const counts = new Map<string, number>();
	for (const turn of flagged)
		counts.set(turn.personaId, (counts.get(turn.personaId) ?? 0) + 1);
	return counts;
}

// Returns the unlocked ids that are still referred personas of the case: not roots, and not removed from the case since the run began.
export function referredContactIds(
	graph: PersonaGraph,
	unlockedReferredIds: Iterable<string>,
): string[] {
	const roots = new Set(graph.roots);
	return [...new Set(unlockedReferredIds)].filter(
		(id) => graph.personas.has(id) && !roots.has(id),
	);
}

// Extra time after a case's duration before its run is deleted.
export const GRACE_PERIOD_MINUTES = 15;

// Hard cap on a run's lifetime. Leaves room for the grace period after the longest allowed duration.
export const RUN_LIFETIME_MINUTES = 240;

// Computes when a run expires: duration plus grace period, capped at the run lifetime.
export function computeExpiresAt(
	startTime: number,
	durationMinutes: number | undefined,
): number {
	const capMs = RUN_LIFETIME_MINUTES * 60_000;
	const ttlMs = durationMinutes
		? Math.min((durationMinutes + GRACE_PERIOD_MINUTES) * 60_000, capMs)
		: capMs;
	return startTime + ttlMs;
}

// Loads a run and its case, throwing student errors if the run or its case is missing. Reads no clock, so it is safe in queries: the scheduled destroy is what ends a run.
export async function loadRun(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<{ run: Doc<"runs">; c: Doc<"cases"> }> {
	const run = await ctx.db.get("runs", runId);
	if (!run) throw studentError(STUDENT_ERROR.RUN_NOT_FOUND, "Run not found.");
	const c = await ctx.db.get("cases", run.caseId);
	if (!c) throw studentError(STUDENT_ERROR.CASE_NOT_FOUND, "Case not found.");
	return { run, c };
}

// Like loadRun, but also rejects a run past its expiry, covering the gap before the scheduled destroy fires. Mutations only.
export async function loadLiveRun(
	ctx: MutationCtx,
	runId: Id<"runs">,
): Promise<{ run: Doc<"runs">; c: Doc<"cases"> }> {
	const loaded = await loadRun(ctx, runId);
	if (Date.now() > loaded.run.expiresAt)
		throw studentError(STUDENT_ERROR.RUN_EXPIRED, "Run expired.");
	return loaded;
}

export const NONSENSE_THRESHOLD = 3;

// Whether a persona has flagged enough messages to end its conversation.
export function isChatEnded(warnings: number): boolean {
	return warnings >= NONSENSE_THRESHOLD;
}

// Returns the canned warning or chat-ending message for a flagged message.
export function boundaryReply(personaName: string, shouldEnd: boolean): string {
	const name = personaName || "I";
	if (shouldEnd) {
		return (
			`${name} is ending this conversation because the messages are not coherent or ` +
			"respectful enough to continue. Please send clear, respectful case-related " +
			"questions to another contact."
		);
	}
	return (
		"I am not able to follow that. Please send a clear, respectful, case-related " +
		"question if you want to continue."
	);
}
