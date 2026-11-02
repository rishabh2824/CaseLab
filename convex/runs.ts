import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { destroyRun, startRun } from "./model/runs";
import {
	exportRunView,
	getPersonaHistoryView,
	getRunView,
} from "./model/runView";

// Starts a simulation run for an access code and returns its id.
export const start = mutation({
	args: { accessCode: v.string() },
	handler: async (ctx, { accessCode }) => startRun(ctx, accessCode),
});

// Returns the current state of a run for the student view.
export const get = query({
	args: { runId: v.id("runs") },
	handler: async (ctx, { runId }) => getRunView(ctx, runId),
});

// Returns one contact's chat history, the state of its latest reply, and the student's last message when its reply failed.
export const getPersonaHistory = query({
	args: { runId: v.id("runs"), personaId: v.string() },
	handler: async (ctx, { runId, personaId }) =>
		getPersonaHistoryView(ctx, runId, personaId),
});

// Returns every unlocked persona's transcript for export.
export const exportRun = query({
	args: { runId: v.id("runs") },
	handler: async (ctx, { runId }) => exportRunView(ctx, runId),
});

// Deletes a run together with its turns; scheduled when the run starts.
export const destroy = internalMutation({
	args: { runId: v.id("runs") },
	handler: async (ctx, { runId }) => destroyRun(ctx, runId),
});
