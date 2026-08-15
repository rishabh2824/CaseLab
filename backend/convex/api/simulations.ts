import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import {
	deleteExpiredRuns as deleteExpiredRunsService,
	deleteRunCascade,
	exportSimulation,
	getPersonaHistory as getPersonaHistoryService,
	getSimulationState,
	startSimulation,
} from "../services/simulations";

// Mirrors backend/api/simulations.py's POST /simulations/start. Public and unauthenticated,
// same as the old endpoint -- a student is gated only by knowing a valid access code, not by
// signing in.
export const start = mutation({
	args: { accessCode: v.string() },
	handler: async (ctx, args) => await startSimulation(ctx, args.accessCode),
});

// Mirrors backend/api/simulations.py's GET /simulations/{run_id}, minus the per-persona
// histories it used to also return -- see RunStateOut's own comment (services/
// simulations.ts) for why. getPersonaHistory (below) is the scoped replacement.
export const get = query({
	args: { runId: v.id("runs") },
	handler: async (ctx, args) => await getSimulationState(ctx, args.runId),
});

// Scoped to one persona's transcript -- the frontend subscribes to this (keyed by whichever
// contact's chat panel is open) instead of getting every persona's history folded into the
// `get` query above, for the same cost reason streamingReplies (services/turn.ts) is its own
// table rather than a field on the run.
export const getPersonaHistory = query({
	args: { runId: v.id("runs"), personaId: v.string() },
	handler: async (ctx, args) => await getPersonaHistoryService(ctx, args.runId, args.personaId),
});

// Mirrors backend/api/simulations.py's GET /simulations/{run_id}/export. Named `exportRun`,
// not `export` -- the latter is a reserved word and can't be a binding name.
export const exportRun = query({
	args: { runId: v.id("runs") },
	handler: async (ctx, args) => await exportSimulation(ctx, args.runId),
});

// Scheduled by startSimulation for a run's expiry -- deletes the run (and, via
// deleteRunCascade, its messages and any streaming-preview row) the instant it expires,
// replacing backend/services/simulation/run_store.py's daily cleanupRuns() full-table sweep
// with precise per-run deletion.
export const destroy = internalMutation({
	args: { runId: v.id("runs") },
	handler: async (ctx, args) => await deleteRunCascade(ctx, args.runId),
});

// Called by crons.ts's weekly reconciliation sweep -- see deleteExpiredRuns's own comment
// for why this should normally delete nothing.
export const deleteExpiredRuns = internalMutation({
	args: {},
	handler: async (ctx) => await deleteExpiredRunsService(ctx),
});
