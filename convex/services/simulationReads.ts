import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { rootIds } from "../lib/caseGraph";
import type {
	CaseStructure,
	PersonaPayload,
	ReferralEdgePayload,
} from "../models/cases";

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
	).sort((a, b) =>
		(personas.get(a)?.name ?? "").localeCompare(personas.get(b)?.name ?? ""),
	);
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

// Dedupes unlocked ids and drops any that are roots.
export function referredContactIds(
	graph: PersonaGraph,
	unlockedReferredIds: Iterable<string>,
): string[] {
	const roots = new Set(graph.roots);
	return [...new Set(unlockedReferredIds)].filter((id) => !roots.has(id));
}
