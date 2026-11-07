import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const FLAG_LIMIT = 3;

// Whether a persona has flagged enough messages to end its conversation.
export function isChatEnded(flagCount: number): boolean {
	return flagCount >= FLAG_LIMIT;
}

// Counts each persona's flagged turns in a run that count toward ending its chat, which is every flag but gibberish. Flagged turns are rare and only exist within one run, so this stays small.
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
	for (const turn of flagged) {
		if (turn.flagReason === "gibberish") continue;
		counts.set(turn.personaId, (counts.get(turn.personaId) ?? 0) + 1);
	}
	return counts;
}

// Returns the canned warning or chat-ending message for a flagged message.
export function flagReply(personaName: string, shouldEnd: boolean): string {
	if (shouldEnd) {
		return (
			`${personaName} is ending this conversation after repeated messages that were ` +
			"unclear, disrespectful or not part of the simulation. Please keep your " +
			"messages to other contacts clear and respectful."
		);
	}
	return (
		"I can't respond to that. Please send a clear, respectful message if you want " +
		"to continue."
	);
}
