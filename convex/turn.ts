import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
} from "./_generated/server";
import { MAX_MESSAGE_WORDS } from "./lib/constants";
import { LLM_ATTEMPT_TIMEOUT_MS, PERSONA_REPLY_RETRIES } from "./lib/llm";
import { STUDENT_ERROR, studentError } from "./lib/studentErrors";
import {
	boundaryReply,
	type ChatStateOut,
	elapsedMinutes,
	getChatState,
	NONSENSE_THRESHOLD,
	personaAvailability,
} from "./lib/turnState";
import { flattenPersonas } from "./services/simulationReads";
import {
	buildTurnContext,
	generateReply,
	type ReplyJob,
} from "./services/turnReply";
import { loadLiveRun, loadRun } from "./simulations";

// How long a reply may stay pending before it is failed. Covers the slowest LLM attempts plus a margin.
export const TURN_EXPIRY_MS =
	LLM_ATTEMPT_TIMEOUT_MS * PERSONA_REPLY_RETRIES + 10_000;

// Builds the student error for a persona that isn't available yet.
const personaUnavailable = () =>
	studentError(
		STUDENT_ERROR.PERSONA_UNAVAILABLE,
		"Persona is not available yet.",
	);

// Returns the newest message row for a persona in a run.
async function lastRow(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<Doc<"runMessages"> | null> {
	return await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaId", personaId),
		)
		.order("desc")
		.first();
}

// Returns the reply row if it is still pending, otherwise null so late callers do nothing.
async function pendingReply(
	ctx: MutationCtx,
	replyId: Id<"runMessages">,
): Promise<Doc<"runMessages"> | null> {
	const reply = await ctx.db.get("runMessages", replyId);
	return reply?.status === "pending" ? reply : null;
}

// Saves a student message with a pending reply and starts generating the reply.
export const sendMessage = mutation({
	args: { runId: v.id("runs"), personaId: v.string(), message: v.string() },
	handler: async (
		ctx,
		{ runId, personaId, message: rawMessage },
	): Promise<{ replyId: Id<"runMessages"> }> => {
		const message = rawMessage.trim();
		if (!personaId || !message)
			throw studentError(
				STUDENT_ERROR.MESSAGE_REQUIRED,
				"personaId and message are required.",
			);
		if (message.split(/\s+/).filter(Boolean).length > MAX_MESSAGE_WORDS) {
			throw studentError(
				STUDENT_ERROR.MESSAGE_TOO_LONG,
				`Message is too long (${MAX_MESSAGE_WORDS} words max). Please shorten it and try again.`,
			);
		}

		const { run, c } = await loadLiveRun(ctx, runId);
		if (getChatState(run.personaChatState, personaId).ended)
			throw studentError(
				STUDENT_ERROR.CONVERSATION_ENDED,
				"This conversation has ended.",
			);

		const elapsed = elapsedMinutes(run._creationTime, Date.now());
		if (c.duration && elapsed >= c.duration)
			throw studentError(
				STUDENT_ERROR.SIMULATION_ENDED,
				"This simulation has ended.",
			);

		const graph = flattenPersonas(c.structure);
		const persona = graph.personas.get(personaId);
		if (!persona)
			throw studentError(STUDENT_ERROR.PERSONA_NOT_FOUND, "Persona not found.");
		const availableAt = graph.roots.includes(personaId)
			? 0
			: Object.hasOwn(run.unlockedAt, personaId)
				? run.unlockedAt[personaId]!
				: null;
		if (availableAt === null) throw personaUnavailable();
		if (
			!personaAvailability(persona.availabilityMinutes, availableAt, elapsed)
				.available
		) {
			throw personaUnavailable();
		}

		const previous = await lastRow(ctx, runId, personaId);
		if (previous?.role === "assistant" && previous.status === "pending") {
			throw studentError(
				STUDENT_ERROR.REPLY_IN_PROGRESS,
				"A reply is already being generated for this contact. Please wait.",
			);
		}

		const userMessageId = await ctx.db.insert("runMessages", {
			runId,
			personaId: personaId,
			role: "user",
			content: message,
			status: "done",
		});
		const replyId = await ctx.db.insert("runMessages", {
			runId,
			personaId: personaId,
			role: "assistant",
			content: "",
			status: "pending",
			userMessageId,
		});
		await ctx.scheduler.runAfter(0, internal.turn.reply, { replyId });
		await ctx.scheduler.runAfter(TURN_EXPIRY_MS, internal.turn.failTurn, {
			replyId,
		});
		return { replyId };
	},
});

// Loads what the reply action needs for a pending reply, or null if it already finished or was failed.
export const turnContext = internalQuery({
	args: { replyId: v.id("runMessages") },
	handler: async (ctx, { replyId }): Promise<ReplyJob | null> => {
		const reply = await ctx.db.get("runMessages", replyId);
		if (reply?.status !== "pending" || !reply.userMessageId) return null;
		const userRow = await ctx.db.get("runMessages", reply.userMessageId);
		if (!userRow) return null;

		const { run, c } = await loadRun(ctx, reply.runId);
		const graph = flattenPersonas(c.structure);
		const persona = graph.personas.get(reply.personaId);
		if (!persona) return null;
		const context = await buildTurnContext(
			ctx,
			run,
			c,
			graph,
			persona,
			userRow._creationTime,
		);
		return {
			replyId,
			runId: run._id,
			personaId: persona.id,
			message: userRow.content,
			context,
		};
	},
});

// Runs a pending reply: classifies the message, generates the reply and applies its outcome, failing the turn on any error.
export const reply = internalAction({
	args: { replyId: v.id("runMessages") },
	handler: async (ctx, { replyId }): Promise<void> => {
		try {
			const job = await ctx.runQuery(internal.turn.turnContext, { replyId });
			if (job) await generateReply(ctx, job);
		} catch (err) {
			console.error("Reply failed", err);
			await ctx.runMutation(internal.turn.failTurn, { replyId });
		}
	},
});

// Fails a pending reply: removes the student message and keeps a hidden failed row so the client can tell.
export const failTurn = internalMutation({
	args: { replyId: v.id("runMessages") },
	handler: async (ctx, { replyId }): Promise<void> => {
		const reply = await pendingReply(ctx, replyId);
		if (!reply) return;
		if (reply.userMessageId)
			await ctx.db.delete("runMessages", reply.userMessageId);
		await ctx.db.patch("runMessages", replyId, {
			status: "failed",
			userMessageId: undefined,
		});
	},
});

// Records a warning or chat-ending boundary reply for a flagged message, dropping that message.
export const applyBoundary = internalMutation({
	args: {
		replyId: v.id("runMessages"),
		label: v.string(),
		personaName: v.string(),
	},
	handler: async (
		ctx,
		{ replyId, label, personaName },
	): Promise<ChatStateOut | null> => {
		const reply = await pendingReply(ctx, replyId);
		if (!reply) return null;
		const run = await ctx.db.get("runs", reply.runId);
		if (!run) return null;

		const previous = getChatState(run.personaChatState, reply.personaId);
		const warningCount = previous.warningCount + 1;
		const ended = warningCount >= NONSENSE_THRESHOLD;
		const endReason = ended ? label : previous.endReason;
		await ctx.db.patch("runs", run._id, {
			personaChatState: {
				...run.personaChatState,
				[reply.personaId]: {
					warningCount,
					ended,
					endReason: endReason ?? undefined,
				},
			},
		});

		if (reply.userMessageId)
			await ctx.db.delete("runMessages", reply.userMessageId);
		await ctx.db.patch("runMessages", replyId, {
			content: boundaryReply(personaName, ended),
			status: "done",
			userMessageId: undefined,
		});
		return { ended, endReason: endReason ?? null, warningCount };
	},
});

// Saves the finished reply, unlocks the introduced personas and records shared files.
export const applyDecisions = internalMutation({
	args: {
		replyId: v.id("runMessages"),
		reply: v.string(),
		unlockedReferrals: v.array(v.object({ referredPersonaId: v.string() })),
		sharedFiles: v.array(v.object({ storageId: v.id("_storage") })),
	},
	handler: async (
		ctx,
		{ replyId, reply: replyText, unlockedReferrals, sharedFiles },
	): Promise<void> => {
		const reply = await pendingReply(ctx, replyId);
		if (!reply) return;
		const run = await ctx.db.get("runs", reply.runId);
		if (!run) return;

		// Writing the run re-runs every subscribed run-state query, so only do it when something changed.
		const elapsed = elapsedMinutes(run._creationTime, Date.now());
		const unlockedAt = { ...run.unlockedAt };
		let unlockedAny = false;
		for (const { referredPersonaId } of unlockedReferrals) {
			if (Object.hasOwn(unlockedAt, referredPersonaId)) continue;
			unlockedAt[referredPersonaId] = elapsed;
			unlockedAny = true;
		}

		const sharedFileIds = new Set(run.sharedFiles);
		for (const file of sharedFiles) sharedFileIds.add(file.storageId);
		const sharedAny = sharedFileIds.size > run.sharedFiles.length;

		if (unlockedAny || sharedAny) {
			await ctx.db.patch("runs", run._id, {
				unlockedAt,
				sharedFiles: [...sharedFileIds],
			});
		}
		await ctx.db.patch("runMessages", replyId, {
			content: replyText,
			status: "done",
		});
	},
});
