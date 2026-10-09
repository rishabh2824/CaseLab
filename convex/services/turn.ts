import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_MESSAGE_WORDS } from "../lib/constants";
import {
	classifyHarassment,
	LLM_ATTEMPT_TIMEOUT_MS,
	PERSONA_REPLY_RETRIES,
	personaReplyStream,
	RECENT_HISTORY_LIMIT,
} from "../lib/llm";
import {
	type CandidateFile,
	type CandidateReferral,
	cleanReply,
	coerceHandles,
	parseReply,
	replyInstructions,
	systemPrompt,
} from "../lib/prompt";
import { STUDENT_ERROR, studentError } from "../lib/studentErrors";
import {
	boundaryReply,
	type ChatStateOut,
	elapsedMinutes,
	getChatState,
	NONSENSE_THRESHOLD,
	personaAvailability,
} from "../lib/turnState";
import type { PersonaPayload } from "../models/cases";
import {
	flattenPersonas,
	graphReferrals,
	type PersonaGraph,
} from "./simulationReads";
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

// Validates a student message, saves it with a pending reply row and schedules the reply and its expiry.
export async function sendMessage(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	rawMessage: string,
): Promise<{ replyId: Id<"runMessages"> }> {
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
	await ctx.scheduler.runAfter(0, internal.api.turn.reply, { replyId });
	await ctx.scheduler.runAfter(TURN_EXPIRY_MS, internal.api.turn.failTurn, {
		replyId,
	});
	return { replyId };
}

type PendingReferral = {
	referredPersonaId: string;
	conditionTrigger: string;
	referredName: string;
	referredRole: string;
};
type PendingFile = {
	storageId: Id<"_storage">;
	fileName: string;
	shareConditions: string;
	perceivedContents: string;
};
type DecisionMessage = { role: "user" | "assistant"; content: string };

export type TurnContext = {
	caseBrief: string;
	commonInformation: string;
	persona: PersonaPayload;
	pendingReferrals: PendingReferral[];
	pendingFiles: PendingFile[];
	decisionHistory: DecisionMessage[];
};

export type ReplyJob = {
	replyId: Id<"runMessages">;
	runId: Id<"runs">;
	personaId: string;
	message: string;
	context: TurnContext;
};

// Gathers the pending referrals and files and the history before the student message needed to generate a reply.
async function buildTurnContext(
	ctx: QueryCtx,
	run: Doc<"runs">,
	c: Doc<"cases">,
	graph: PersonaGraph,
	persona: PersonaPayload,
	beforeCreationTime: number,
): Promise<TurnContext> {
	const pendingReferrals: PendingReferral[] = graphReferrals(graph, persona.id)
		.filter(
			(referral) =>
				!Object.hasOwn(run.unlockedAt, referral.toId) &&
				!graph.roots.includes(referral.toId) &&
				referral.conditions.trim(),
		)
		.map((referral) => {
			const referred = graph.personas.get(referral.toId);
			return {
				referredPersonaId: referral.toId,
				conditionTrigger: referral.conditions,
				referredName: referred?.name ?? "",
				referredRole: referred?.role ?? "",
			};
		});

	const pendingFiles: PendingFile[] = persona.files.flatMap((entry) => {
		const file = entry.file;
		if (
			!file ||
			!entry.shareConditions.trim() ||
			run.sharedFiles.includes(file.storageId)
		)
			return [];
		return [
			{
				storageId: file.storageId,
				fileName: file.fileName || "file",
				shareConditions: entry.shareConditions,
				perceivedContents: entry.perceivedContents,
			},
		];
	});

	const rows = await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) =>
			q
				.eq("runId", run._id)
				.eq("personaId", persona.id)
				.lt("_creationTime", beforeCreationTime),
		)
		.filter((q) => q.eq(q.field("status"), "done"))
		.order("desc")
		.take(RECENT_HISTORY_LIMIT);
	rows.reverse();

	return {
		caseBrief: c.brief,
		commonInformation: c.commonInformation,
		persona,
		pendingReferrals,
		pendingFiles,
		decisionHistory: rows.map((row) => ({
			role: row.role,
			content: row.content,
		})),
	};
}

// Loads what the reply action needs for a pending reply, or null if it already finished or was failed.
export async function loadTurn(
	ctx: QueryCtx,
	replyId: Id<"runMessages">,
): Promise<ReplyJob | null> {
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
}

// Returns the reply row if it is still pending, otherwise null so late callers do nothing.
async function pendingReply(
	ctx: MutationCtx,
	replyId: Id<"runMessages">,
): Promise<Doc<"runMessages"> | null> {
	const reply = await ctx.db.get("runMessages", replyId);
	return reply?.status === "pending" ? reply : null;
}

// Fails a pending reply: removes the student message and keeps a hidden failed row so the client can tell.
export async function failTurn(
	ctx: MutationCtx,
	replyId: Id<"runMessages">,
): Promise<void> {
	const reply = await pendingReply(ctx, replyId);
	if (!reply) return;
	if (reply.userMessageId)
		await ctx.db.delete("runMessages", reply.userMessageId);
	await ctx.db.patch("runMessages", replyId, {
		status: "failed",
		userMessageId: undefined,
	});
}

// Records a warning or chat-ending boundary reply for a flagged message, dropping that message.
export async function applyBoundary(
	ctx: MutationCtx,
	replyId: Id<"runMessages">,
	label: string,
	personaName: string,
): Promise<ChatStateOut | null> {
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
}

export type UnlockedReferral = { referredPersonaId: string };
export type SharedFileInput = { storageId: Id<"_storage"> };

// Saves the finished reply, unlocks the introduced personas and records shared files.
export async function applyDecisions(
	ctx: MutationCtx,
	replyId: Id<"runMessages">,
	replyText: string,
	unlockedReferrals: UnlockedReferral[],
	sharedFiles: SharedFileInput[],
): Promise<void> {
	const reply = await pendingReply(ctx, replyId);
	if (!reply) return;
	const run = await ctx.db.get("runs", reply.runId);
	if (!run) return;

	const elapsed = elapsedMinutes(run._creationTime, Date.now());
	const unlockedAt = { ...run.unlockedAt };
	for (const { referredPersonaId } of unlockedReferrals) {
		if (Object.hasOwn(unlockedAt, referredPersonaId)) continue;
		unlockedAt[referredPersonaId] = elapsed;
	}

	const sharedFileIds = new Set(run.sharedFiles);
	for (const file of sharedFiles) sharedFileIds.add(file.storageId);

	await ctx.db.patch("runs", run._id, {
		unlockedAt,
		sharedFiles: [...sharedFileIds],
	});
	await ctx.db.patch("runMessages", replyId, {
		content: replyText,
		status: "done",
	});
}

// Runs a pending reply: classifies the message, generates the reply and applies its outcome, failing the turn on any error.
export async function runReply(
	ctx: ActionCtx,
	replyId: Id<"runMessages">,
): Promise<void> {
	try {
		const job = await ctx.runQuery(internal.api.turn.turnContext, { replyId });
		if (job) await generateReply(ctx, job);
	} catch (err) {
		console.error("Reply failed", err);
		await ctx.runMutation(internal.api.turn.failTurn, { replyId });
	}
}

// Generates the persona reply for a job and saves it, or saves a boundary reply if the message was flagged.
async function generateReply(
	ctx: ActionCtx,
	{ replyId, message, context }: ReplyJob,
): Promise<void> {
	const harassmentPromise = classifyHarassment(
		message,
		context.decisionHistory,
	);

	const referralByHandle = new Map<string, PendingReferral>();
	const candidateReferrals: CandidateReferral[] = context.pendingReferrals.map(
		(referral, i) => {
			const handle = `R${i + 1}`;
			referralByHandle.set(handle, referral);
			return {
				handle,
				name: referral.referredName,
				role: referral.referredRole,
				conditionTrigger: referral.conditionTrigger,
			};
		},
	);

	const fileByHandle = new Map<string, PendingFile>();
	const candidateFiles: CandidateFile[] = context.pendingFiles.map(
		(file, i) => {
			const handle = `F${i + 1}`;
			fileByHandle.set(handle, file);
			return {
				handle,
				name: file.fileName,
				perceivedContents: file.perceivedContents,
				shareConditions: file.shareConditions,
			};
		},
	);

	const { stable, dynamic } = systemPrompt(
		context.caseBrief,
		context.commonInformation,
		context.persona,
		candidateReferrals,
		candidateFiles,
	);
	const cacheableSystemPrompt = `${replyInstructions()}\n\n---\n\n${stable}`;

	let fullText = "";
	const replyHistory = [
		...context.decisionHistory,
		{ role: "user" as const, content: message },
	];
	for await (const delta of personaReplyStream(
		{ cacheable: cacheableSystemPrompt, dynamic },
		replyHistory,
	)) {
		if (delta.type === "reset") fullText = "";
		else fullText += delta.text;
	}

	const label = await harassmentPromise;
	if (label !== "normal") {
		await ctx.runMutation(internal.api.turn.applyBoundary, {
			replyId,
			label,
			personaName: context.persona.name,
		});
		return;
	}

	const parsed = parseReply(fullText);
	const reply = cleanReply((parsed?.reply as string | undefined) ?? "");
	if (!reply.trim()) throw new Error("The reply came back empty.");

	const unlockedReferrals = [...new Set(coerceHandles(parsed?.introduce))]
		.map((handle) => referralByHandle.get(handle))
		.filter((r): r is PendingReferral => r !== undefined)
		.map((r) => ({ referredPersonaId: r.referredPersonaId }));

	const sharedFiles = [...new Set(coerceHandles(parsed?.sendFiles))]
		.map((handle) => fileByHandle.get(handle))
		.filter((f): f is PendingFile => f !== undefined)
		.map((f) => ({ storageId: f.storageId }));

	await ctx.runMutation(internal.api.turn.applyDecisions, {
		replyId,
		reply,
		unlockedReferrals,
		sharedFiles,
	});
}
