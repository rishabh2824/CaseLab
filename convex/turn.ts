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
import { MAX_MESSAGE_CHARS, MAX_MESSAGE_WORDS } from "./lib/constants";
import { LLM_ATTEMPT_TIMEOUT_MS, PERSONA_REPLY_RETRIES } from "./lib/llm";
import { countWords } from "./lib/messageRules";
import { STUDENT_ERROR, studentError } from "./lib/studentErrors";
import {
	boundaryReply,
	elapsedMinutes,
	isChatEnded,
	personaAvailability,
} from "./lib/turnState";
import { flaggedCounts, flattenPersonas } from "./services/simulationReads";
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

// Returns the newest turn for a persona in a run.
async function lastTurn(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<Doc<"turns"> | null> {
	return await ctx.db
		.query("turns")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaId", personaId),
		)
		.order("desc")
		.first();
}

// Returns the turn if it is still pending, otherwise null so late callers do nothing.
async function pendingTurn(
	ctx: MutationCtx,
	turnId: Id<"turns">,
): Promise<Doc<"turns"> | null> {
	const turn = await ctx.db.get("turns", turnId);
	return turn?.status === "pending" ? turn : null;
}

// Saves a student message as a pending turn and starts generating the reply.
export const sendMessage = mutation({
	args: { runId: v.id("runs"), personaId: v.string(), message: v.string() },
	handler: async (
		ctx,
		{ runId, personaId, message: rawMessage },
	): Promise<{ turnId: Id<"turns"> }> => {
		const message = rawMessage.trim();
		if (!personaId || !message)
			throw studentError(
				STUDENT_ERROR.MESSAGE_REQUIRED,
				"personaId and message are required.",
			);
		if (countWords(message) > MAX_MESSAGE_WORDS) {
			throw studentError(
				STUDENT_ERROR.MESSAGE_TOO_LONG,
				`Message is too long (${MAX_MESSAGE_WORDS} words max). Please shorten it and try again.`,
			);
		}
		if (message.length > MAX_MESSAGE_CHARS) {
			throw studentError(
				STUDENT_ERROR.MESSAGE_TOO_LONG,
				`Message is too long (${MAX_MESSAGE_CHARS} characters max). Please shorten it and try again.`,
			);
		}

		const { run, c } = await loadLiveRun(ctx, runId);
		const warnings = (await flaggedCounts(ctx, runId)).get(personaId) ?? 0;
		if (isChatEnded(warnings))
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
			!personaAvailability(
				persona.availabilityMinutes ?? null,
				availableAt,
				elapsed,
			).available
		) {
			throw personaUnavailable();
		}

		const previous = await lastTurn(ctx, runId, personaId);
		if (previous?.status === "pending") {
			throw studentError(
				STUDENT_ERROR.REPLY_IN_PROGRESS,
				"A reply is already being generated for this contact. Please wait.",
			);
		}

		const turnId = await ctx.db.insert("turns", {
			runId,
			personaId,
			studentMessage: message,
			reply: "",
			status: "pending",
		});
		await ctx.scheduler.runAfter(0, internal.turn.reply, { turnId });
		await ctx.scheduler.runAfter(TURN_EXPIRY_MS, internal.turn.failTurn, {
			turnId,
		});
		return { turnId };
	},
});

// Loads what the reply action needs for a pending turn, or null if it already finished or was failed.
export const turnContext = internalQuery({
	args: { turnId: v.id("turns") },
	handler: async (ctx, { turnId }): Promise<ReplyJob | null> => {
		const turn = await ctx.db.get("turns", turnId);
		if (turn?.status !== "pending") return null;

		const { run, c } = await loadRun(ctx, turn.runId);
		const graph = flattenPersonas(c.structure);
		const persona = graph.personas.get(turn.personaId);
		if (!persona) return null;
		const context = await buildTurnContext(
			ctx,
			run,
			c,
			graph,
			persona,
			turn._creationTime,
		);
		return {
			turnId,
			runId: run._id,
			personaId: persona.id,
			message: turn.studentMessage,
			context,
		};
	},
});

// Runs a pending turn: classifies the message, generates the reply and applies its outcome, failing the turn on any error.
export const reply = internalAction({
	args: { turnId: v.id("turns") },
	handler: async (ctx, { turnId }): Promise<void> => {
		try {
			const job = await ctx.runQuery(internal.turn.turnContext, { turnId });
			if (job) await generateReply(ctx, job);
			// Nothing to generate (for example the persona was removed mid-reply): fail the turn now rather than leave it pending until the expiry. A no-op if it already finished.
			else await ctx.runMutation(internal.turn.failTurn, { turnId });
		} catch (err) {
			console.error("Reply failed", err);
			await ctx.runMutation(internal.turn.failTurn, { turnId });
		}
	},
});

// Fails a pending turn. It keeps the student's message but is hidden from the chat.
export const failTurn = internalMutation({
	args: { turnId: v.id("turns") },
	handler: async (ctx, { turnId }): Promise<void> => {
		if (!(await pendingTurn(ctx, turnId))) return;
		await ctx.db.patch("turns", turnId, { status: "failed" });
	},
});

// Flags a pending turn and answers it with a warning, or a chat-ending boundary reply once the persona has flagged enough messages.
export const applyBoundary = internalMutation({
	args: {
		turnId: v.id("turns"),
		personaName: v.string(),
	},
	handler: async (ctx, { turnId, personaName }): Promise<void> => {
		const turn = await pendingTurn(ctx, turnId);
		if (!turn) return;

		const previous =
			(await flaggedCounts(ctx, turn.runId)).get(turn.personaId) ?? 0;
		await ctx.db.patch("turns", turnId, {
			reply: boundaryReply(personaName, isChatEnded(previous + 1)),
			status: "flagged",
		});
	},
});

// Saves the finished reply, unlocks the introduced personas and records shared files.
export const applyDecisions = internalMutation({
	args: {
		turnId: v.id("turns"),
		reply: v.string(),
		unlockedReferrals: v.array(v.object({ referredPersonaId: v.string() })),
		sharedFiles: v.array(v.object({ storageId: v.id("_storage") })),
	},
	handler: async (
		ctx,
		{ turnId, reply: replyText, unlockedReferrals, sharedFiles },
	): Promise<void> => {
		const turn = await pendingTurn(ctx, turnId);
		if (!turn) return;
		const run = await ctx.db.get("runs", turn.runId);
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
		await ctx.db.patch("turns", turnId, { reply: replyText, status: "done" });
	},
});
