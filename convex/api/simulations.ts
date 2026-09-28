import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import {
	deleteRunCascade,
	exportSimulation,
	getPersonaHistory as getPersonaHistoryService,
	getSimulationState,
	startSimulation,
} from "../services/simulations";

// Starts a simulation run for an access code and returns its initial state.
export const start = mutation({
	args: { accessCode: v.string() },
	handler: async (ctx, args) => await startSimulation(ctx, args.accessCode),
});

// Returns the current state of a run for the student view.
export const get = query({
	args: { runId: v.id("runs") },
	handler: async (ctx, args) => await getSimulationState(ctx, args.runId),
});

// Returns the message history between the student and one persona.
export const getPersonaHistory = query({
	args: { runId: v.id("runs"), personaId: v.string() },
	handler: async (ctx, args) =>
		await getPersonaHistoryService(ctx, args.runId, args.personaId),
});

// Returns the full transcript and contacts of a run for export.
export const exportRun = query({
	args: { runId: v.id("runs") },
	handler: async (ctx, args) => await exportSimulation(ctx, args.runId),
});

// Deletes a run and everything that belongs to it (scheduled when the run starts).
export const destroy = internalMutation({
	args: { runId: v.id("runs") },
	handler: async (ctx, args) => await deleteRunCascade(ctx, args.runId),
});
