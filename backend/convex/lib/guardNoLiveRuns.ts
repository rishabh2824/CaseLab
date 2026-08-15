import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// A `runs` row is deleted (via the scheduled job set up when it's created) the moment it
// expires, so any row present here is by definition still live. Shared by
// services/admins.ts's deleteAdminWithCascade (deleting an admin can cascade-delete their
// owned cases) and services/cases.ts's updateCase/deleteCase.
export async function guardNoLiveRuns(ctx: QueryCtx, caseId: Id<"cases">): Promise<void> {
	const liveRun = await ctx.db
		.query("runs")
		.withIndex("by_case", (q) => q.eq("caseId", caseId))
		.first();
	if (liveRun) throw new Error("This case has an active simulation in progress.");
}
