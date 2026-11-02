import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { elapsedMinutes, personaAvailability } from "../shared/availability";
import { appError, ERROR_CODE } from "../shared/errors";
import { countWords, MAX_MESSAGE_WORDS } from "../shared/rules";
import { flaggedCounts, flagReply, isChatEnded } from "./flags";
import { LLM_ATTEMPT_TIMEOUT_MS, PERSONA_REPLY_RETRIES } from "./llm";
import { flattenPersonas } from "./personaGraph";
import { buildTurnContext, generateReply, type ReplyJob } from "./reply";
import { loadLiveRun, loadRun } from "./runs";

// How long a reply may stay pending before it is failed. Covers the slowest LLM attempts plus a margin.
export const TURN_EXPIRY_MS =
	LLM_ATTEMPT_TIMEOUT_MS * PERSONA_REPLY_RETRIES + 10_000;

// Builds the student error for a persona that isn't available yet.
const personaUnavailable = () =>
	appError(ERROR_CODE.PERSONA_UNAVAILABLE, "Persona is not available yet.");

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
export async function sendMessage(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	rawMessage: string,
): Promise<{ turnId: Id<"turns"> }> {
	const message = rawMessage.trim();
	if (!personaId || !message)
		throw appError(
			ERROR_CODE.MESSAGE_REQUIRED,
			"personaId and message are required.",
		);
	if (countWords(message) > MAX_MESSAGE_WORDS) {
		throw appError(
			ERROR_CODE.MESSAGE_TOO_LONG,
			`Message is too long (${MAX_MESSAGE_WORDS} words max). Please shorten it and try again.`,
		);
	}

	const { run, c } = await loadLiveRun(ctx, runId);
	const flagCount = (await flaggedCounts(ctx, runId)).get(personaId) ?? 0;
	if (isChatEnded(flagCount))
		throw appError(
			ERROR_CODE.CONVERSATION_ENDED,
			"This conversation has ended.",
		);

	const elapsed = elapsedMinutes(run._creationTime, Date.now());
	if (c.duration && elapsed >= c.duration)
		throw appError(ERROR_CODE.SIMULATION_ENDED, "This simulation has ended.");

	const graph = flattenPersonas(c.structure);
	const persona = graph.personas.get(personaId);
	if (!persona)
		throw appError(ERROR_CODE.PERSONA_NOT_FOUND, "Persona not found.");
	const availableAt = graph.roots.includes(personaId)
		? 0
		: run.unlockedAt[personaId];
	if (availableAt === undefined) throw personaUnavailable();
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
		throw appError(
			ERROR_CODE.REPLY_IN_PROGRESS,
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
	await ctx.scheduler.runAfter(0, internal.turns.reply, { turnId });
	await ctx.scheduler.runAfter(TURN_EXPIRY_MS, internal.turns.failTurn, {
		turnId,
	});
	return { turnId };
}

// Loads what the reply action needs for a pending turn, or null if it already finished or was failed.
export async function loadReplyJob(
	ctx: QueryCtx,
	turnId: Id<"turns">,
): Promise<ReplyJob | null> {
	const turn = await ctx.db.get("turns", turnId);
	if (turn?.status !== "pending") return null;

	const { run, c } = await loadRun(ctx, turn.runId);
	const graph = flattenPersonas(c.structure);
	const context = await buildTurnContext(
		ctx,
		run,
		c,
		graph,
		graph.personas.get(turn.personaId)!,
		turn._creationTime,
	);
	return { turnId, message: turn.studentMessage, context };
}

// Runs a pending turn: classifies the message, generates the reply and applies its outcome, failing the turn on any error.
export async function replyToTurn(
	ctx: ActionCtx,
	turnId: Id<"turns">,
): Promise<void> {
	try {
		const job = await ctx.runQuery(internal.turns.turnContext, { turnId });
		if (job) await generateReply(ctx, job);
	} catch (err) {
		console.error("Reply failed", err);
		await ctx.runMutation(internal.turns.failTurn, { turnId });
	}
}

// Fails a pending turn. It keeps the student's message but is hidden from the chat.
export async function failPendingTurn(
	ctx: MutationCtx,
	turnId: Id<"turns">,
): Promise<void> {
	if (!(await pendingTurn(ctx, turnId))) return;
	await ctx.db.patch("turns", turnId, { status: "failed" });
}

// Flags a pending turn and answers it with a warning, or a chat-ending reply once the persona has flagged enough messages.
export async function flagPendingTurn(
	ctx: MutationCtx,
	turnId: Id<"turns">,
	personaName: string,
): Promise<void> {
	const turn = await pendingTurn(ctx, turnId);
	if (!turn) return;

	const previous =
		(await flaggedCounts(ctx, turn.runId)).get(turn.personaId) ?? 0;
	await ctx.db.patch("turns", turnId, {
		reply: flagReply(personaName, isChatEnded(previous + 1)),
		status: "flagged",
	});
}

// Saves the finished reply, unlocks the introduced personas and records shared files.
export async function completePendingTurn(
	ctx: MutationCtx,
	turnId: Id<"turns">,
	replyText: string,
	unlockedReferrals: { referredPersonaId: string }[],
	sharedFiles: { storageId: Id<"_storage"> }[],
): Promise<void> {
	const turn = await pendingTurn(ctx, turnId);
	if (!turn) return;
	// A turn is deleted together with its run, so a pending turn always has one.
	const run = (await ctx.db.get("runs", turn.runId))!;

	// Writing the run re-runs every subscribed run-state query, so only do it when something changed.
	const elapsed = elapsedMinutes(run._creationTime, Date.now());
	const unlockedAt = { ...run.unlockedAt };
	let unlockedAny = false;
	for (const { referredPersonaId } of unlockedReferrals) {
		if (unlockedAt[referredPersonaId] !== undefined) continue;
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
}
