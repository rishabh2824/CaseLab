import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError, ERROR_CODE } from "../shared/errors";
import { normalizeAccessCode } from "../shared/rules";

// Extra time after a case's duration before its run is deleted.
export const GRACE_PERIOD_MINUTES = 15;

// How long a run without a time limit lasts. Longer than the longest allowed duration plus the grace period.
export const RUN_LIFETIME_MINUTES = 240;

// Computes when a run expires: duration plus grace period, or the full run lifetime when the case has no time limit.
export function computeExpiresAt(
	startTime: number,
	durationMinutes: number | undefined,
): number {
	const ttlMinutes = durationMinutes
		? durationMinutes + GRACE_PERIOD_MINUTES
		: RUN_LIFETIME_MINUTES;
	return startTime + ttlMinutes * 60_000;
}

// Loads a run and its case, throwing an app error if the run is missing. A case is not edited or deleted while students are running it, so the run's case is always there. Reads no clock, so it is safe in queries: the scheduled destroy is what ends a run.
export async function loadRun(
	ctx: QueryCtx,
	runId: Id<"runs">,
): Promise<{ run: Doc<"runs">; c: Doc<"cases"> }> {
	const run = await ctx.db.get("runs", runId);
	if (!run) throw appError(ERROR_CODE.RUN_NOT_FOUND, "Run not found.");
	return { run, c: (await ctx.db.get("cases", run.caseId))! };
}

// Like loadRun, but also rejects a run past its expiry, covering the gap before the scheduled destroy fires. Mutations only.
export async function loadLiveRun(
	ctx: MutationCtx,
	runId: Id<"runs">,
): Promise<{ run: Doc<"runs">; c: Doc<"cases"> }> {
	const loaded = await loadRun(ctx, runId);
	if (Date.now() > loaded.run.expiresAt)
		throw appError(ERROR_CODE.RUN_EXPIRED, "Run expired.");
	return loaded;
}

// Starts a simulation run for an access code, schedules its destruction and returns its id.
export async function startRun(
	ctx: MutationCtx,
	accessCodeRaw: string,
): Promise<{ runId: Id<"runs"> }> {
	const accessCode = normalizeAccessCode(accessCodeRaw);
	if (!accessCode)
		throw appError(ERROR_CODE.ACCESS_CODE_REQUIRED, "Access code is required.");
	const c = await ctx.db
		.query("cases")
		.withIndex("by_access_code", (q) => q.eq("accessCode", accessCode))
		.first();
	if (!c)
		throw appError(ERROR_CODE.INVALID_ACCESS_CODE, "Invalid access code.");

	const expiresAt = computeExpiresAt(Date.now(), c.duration);
	const runId = await ctx.db.insert("runs", {
		caseId: c._id,
		expiresAt,
		unlockedAt: {},
		sharedFiles: [],
	});
	await ctx.scheduler.runAt(expiresAt, internal.runs.destroy, { runId });
	return { runId };
}

// Deletes a run together with its turns; safe to call on a missing run (scheduled when the run starts).
export async function destroyRun(
	ctx: MutationCtx,
	runId: Id<"runs">,
): Promise<void> {
	if ((await ctx.db.get("runs", runId)) === null) return;

	const turns = await ctx.db
		.query("turns")
		.withIndex("by_run_persona", (q) => q.eq("runId", runId))
		.collect();
	for (const turn of turns) await ctx.db.delete("turns", turn._id);

	await ctx.db.delete("runs", runId);
}
