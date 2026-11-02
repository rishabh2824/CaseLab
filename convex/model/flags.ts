import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const FLAG_LIMIT = 3;

// Whether a persona has flagged enough messages to end its conversation.
export function isChatEnded(flagCount: number): boolean {
	return flagCount >= FLAG_LIMIT;
}

// Counts the flagged turns of each persona in a run. A persona flags at most FLAG_LIMIT messages before its chat ends, so this stays small.
export async function flaggedCounts(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<Map<string, number>> {
	const flagged = await ctx.db
		.query("turns")
		.withIndex("by_run_status", (q) =>
			q.eq("runId", runId).eq("status", "flagged"),
		)
		.collect();
	const counts = new Map<string, number>();
	for (const turn of flagged)
		counts.set(turn.personaId, (counts.get(turn.personaId) ?? 0) + 1);
	return counts;
}

// Returns the canned warning or chat-ending message for a flagged message.
export function flagReply(personaName: string, shouldEnd: boolean): string {
	if (shouldEnd) {
		return (
			`${personaName} is ending this conversation because the messages are not coherent or ` +
			"respectful enough to continue. Please send clear, respectful case-related " +
			"questions to another contact."
		);
	}
	return (
		"I am not able to follow that. Please send a clear, respectful, case-related " +
		"question if you want to continue."
	);
}
