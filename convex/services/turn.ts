import type { StreamId } from "@convex-dev/persistent-text-streaming";
import { components, internal } from "../_generated/api";
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
import { ReplyExtractor } from "../lib/replyStream";
import { streaming } from "../lib/streaming";
import { STUDENT_ERROR, studentError } from "../lib/studentErrors";
import {
	boundaryReply,
	type ChatStateOut,
	elapsedMinutes,
	getChatState,
	NONSENSE_THRESHOLD,
	personaAvailability,
} from "../lib/turnState";
import {
	flattenPersonas,
	graphReferrals,
	type PersonaDetail,
	type PersonaGraph,
} from "./simulationReads";
import { loadLiveRun } from "./simulations";

// Builds the student error for a persona that isn't available yet.
const personaUnavailable = () =>
	studentError(
		STUDENT_ERROR.PERSONA_UNAVAILABLE,
		"Persona is not available yet.",
	);

// Inserts a chat message for a persona in a run.
async function appendMessage(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	role: "user" | "assistant",
	content: string,
): Promise<Id<"runMessages">> {
	return await ctx.db.insert("runMessages", {
		runId,
		personaKey: personaId,
		role,
		content,
	});
}

// Validates a student's message and the persona's availability, claims the persona's reply slot and gathers the reply context.
export async function startTurn(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	rawMessage: string,
): Promise<ClaimedTurn> {
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
		!personaAvailability(persona.availabilityDuration, availableAt, elapsed)
			.available
	) {
		throw personaUnavailable();
	}

	const slot = await claimTurnSlot(ctx, runId, personaId);
	const context = await buildTurnContext(ctx, run, c, graph, persona);
	return { ...slot, runId, personaId, message, context };
}

export const STREAMING_SLOT_STALE_MS =
	LLM_ATTEMPT_TIMEOUT_MS * PERSONA_REPLY_RETRIES;

type TurnStreamStatus = "pending" | "streaming" | "done" | "error" | "timeout";

// Returns the persistent-streaming status of a reply stream.
async function streamStatus(
	ctx: QueryCtx | MutationCtx,
	streamId: string,
): Promise<TurnStreamStatus> {
	return await ctx.runQuery(
		components.persistentTextStreaming.lib.getStreamStatus,
		{ streamId },
	);
}

// Creates a reply stream for the persona, rejecting if a fresh open one exists and reclaiming a stale one.
async function claimTurnSlot(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<{ turnId: Id<"turnStreams">; streamId: string }> {
	const existing = await ctx.db
		.query("turnStreams")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.first();
	const now = Date.now();
	if (existing) {
		const status = await streamStatus(ctx, existing.streamId);
		const open = status === "pending" || status === "streaming";
		if (open && now - existing.startedAt < STREAMING_SLOT_STALE_MS) {
			throw studentError(
				STUDENT_ERROR.REPLY_IN_PROGRESS,
				"A reply is already being generated for this contact. Please wait.",
			);
		}
		await streaming.deleteStream(ctx, existing.streamId as StreamId);
	}
	const turn = {
		streamId: await streaming.createStream(ctx),
		startedAt: now,
		settled: false,
	};
	if (existing) {
		await ctx.db.patch(existing._id, turn);
		return { turnId: existing._id, streamId: turn.streamId };
	}
	const turnId = await ctx.db.insert("turnStreams", {
		runId,
		personaKey: personaId,
		...turn,
	});
	return { turnId, streamId: turn.streamId };
}

export type ClaimedTurn = {
	turnId: Id<"turnStreams">;
	streamId: string;
	runId: Id<"runs">;
	personaId: string;
	message: string;
	context: TurnContext;
};

type PendingReferral = {
	referredPersonaId: string;
	conditionTrigger: string;
	referredName: string;
	referredRole: string;
};
type PendingFile = {
	fileId: Id<"files">;
	fileName: string;
	shareConditions: string;
	perceivedContents: string;
};
type DecisionMessage = { role: "user" | "assistant"; content: string };

export type TurnContext = {
	caseBrief: string;
	commonInformation: string | null;
	persona: PersonaDetail;
	pendingReferrals: PendingReferral[];
	pendingFiles: PendingFile[];
	decisionHistory: DecisionMessage[];
};

// Gathers the pending referrals and files and the recent history needed to generate a persona's reply.
async function buildTurnContext(
	ctx: MutationCtx,
	run: Doc<"runs">,
	c: Doc<"cases">,
	graph: PersonaGraph,
	persona: PersonaDetail,
): Promise<TurnContext> {
	const pendingReferrals: PendingReferral[] = graphReferrals(graph, persona.id)
		.filter(
			(referral) =>
				!Object.hasOwn(run.unlockedAt, referral.referredPersonaId) &&
				!graph.roots.includes(referral.referredPersonaId) &&
				referral.conditionTrigger.trim(),
		)
		.map((referral) => {
			const referred = graph.personas.get(referral.referredPersonaId);
			return {
				referredPersonaId: referral.referredPersonaId,
				conditionTrigger: referral.conditionTrigger,
				referredName: referred?.name ?? "",
				referredRole: referred?.role ?? "",
			};
		});

	const pendingFiles: PendingFile[] = (
		await Promise.all(
			persona.files
				.filter((entry) => entry.file && entry.share_conditions.trim())
				.map(async (entry) => {
					const file = entry.file!;
					const row = await ctx.db
						.query("files")
						.withIndex("by_storage_id", (q) =>
							q.eq("storageId", file.storage_id),
						)
						.first();
					if (!row || run.sharedFiles.includes(row._id)) return null;
					return {
						fileId: row._id,
						fileName: file.file_name || "file",
						shareConditions: entry.share_conditions,
						perceivedContents: entry.perceived_contents,
					};
				}),
		)
	).filter((f): f is PendingFile => f !== null);

	const rows = await ctx.db
		.query("runMessages")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", run._id).eq("personaKey", persona.id),
		)
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

// Records a warning or chat-ending boundary reply for a flagged message and settles the turn.
export async function applyBoundary(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	label: string,
	personaName: string,
	turnId: Id<"turnStreams">,
): Promise<ChatStateOut> {
	const run = await ctx.db.get(runId);
	if (!run) throw new Error("Run not found.");

	const previous = getChatState(run.personaChatState, personaId);
	const warningCount = previous.warningCount + 1;
	const ended = warningCount >= NONSENSE_THRESHOLD;
	const endReason = ended ? label : previous.endReason;
	await ctx.db.patch(runId, {
		personaChatState: {
			...run.personaChatState,
			[personaId]: {
				warningCount,
				ended,
				endReason: endReason ?? undefined,
			},
		},
	});

	const reply = boundaryReply(personaName, ended);
	await appendMessage(ctx, runId, personaId, "assistant", reply);
	await ctx.db.patch(turnId, { settled: true });

	return { ended, endReason: endReason ?? null, warningCount };
}

export type UnlockedReferral = { referredPersonaId: string };
export type SharedFileInput = { fileId: Id<"files"> };

// Saves the student's message and the reply, unlocks the introduced personas, records shared files and settles the turn.
export async function applyDecisions(
	ctx: MutationCtx,
	runId: Id<"runs">,
	personaId: string,
	message: string,
	reply: string,
	unlockedReferrals: UnlockedReferral[],
	sharedFiles: SharedFileInput[],
	turnId: Id<"turnStreams">,
): Promise<void> {
	const run = await ctx.db.get(runId);
	if (!run) throw new Error("Run not found.");

	const elapsed = elapsedMinutes(run._creationTime, Date.now());
	const unlockedAt = { ...run.unlockedAt };
	for (const { referredPersonaId } of unlockedReferrals) {
		if (Object.hasOwn(unlockedAt, referredPersonaId)) continue;
		unlockedAt[referredPersonaId] = elapsed;
	}

	const sharedFileIds = new Set(run.sharedFiles);
	for (const file of sharedFiles) sharedFileIds.add(file.fileId);

	await ctx.db.patch(runId, {
		unlockedAt,
		sharedFiles: [...sharedFileIds],
	});
	await appendMessage(ctx, runId, personaId, "user", message);
	await appendMessage(ctx, runId, personaId, "assistant", reply);
	await ctx.db.patch(turnId, { settled: true });
}

export type TurnStreamOut = {
	streamId: string;
	status: TurnStreamStatus;
	settled: boolean;
	text: string;
} | null;

// Returns a persona's reply stream state, including its text while it is still streaming if requested.
export async function getTurnStream(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
	withText: boolean,
): Promise<TurnStreamOut> {
	const row = await ctx.db
		.query("turnStreams")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaKey", personaId),
		)
		.first();
	if (!row) return null;
	const turn = { streamId: row.streamId, settled: row.settled };
	if (!withText || row.settled)
		return { ...turn, status: await streamStatus(ctx, row.streamId), text: "" };
	return {
		...turn,
		...(await streaming.getStreamBody(ctx, row.streamId as StreamId)),
	};
}

// Runs a claimed turn: classifies the message, streams the reply and applies its decisions.
export async function runTurn(
	ctx: ActionCtx,
	{ turnId, runId, personaId, message, context }: ClaimedTurn,
	append: (text: string) => Promise<void>,
): Promise<void> {
	const harassmentPromise = classifyHarassment(
		message,
		context.decisionHistory,
	);
	let cleared = false;
	void harassmentPromise.then((label) => {
		cleared = label === "normal";
	});

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
	let extractor = new ReplyExtractor();
	let pending = "";
	let appended = false;
	const replyHistory = [
		...context.decisionHistory,
		{ role: "user" as const, content: message },
	];
	for await (const delta of personaReplyStream(
		{ cacheable: cacheableSystemPrompt, dynamic },
		replyHistory,
	)) {
		if (delta.type === "reset") {
			if (appended) throw new Error("Reply failed after it started streaming.");
			fullText = "";
			pending = "";
			extractor = new ReplyExtractor();
			continue;
		}
		fullText += delta.text;
		pending += extractor.feed(delta.text);
		if (cleared && pending) {
			await append(pending);
			pending = "";
			appended = true;
		}
	}

	const label = await harassmentPromise;
	if (label !== "normal") {
		await ctx.runMutation(internal.api.turn.applyBoundary, {
			runId,
			personaId,
			label,
			personaName: context.persona.name,
			turnId,
		});
		return;
	}

	if (pending) await append(pending);

	const parsed = parseReply(fullText);
	const reply = cleanReply((parsed?.reply as string | undefined) ?? "");
	if (!reply.trim()) throw new Error("The reply came back empty.");

	const unlockedReferrals = [...new Set(coerceHandles(parsed?.introduce))]
		.map((handle) => referralByHandle.get(handle))
		.filter((r): r is PendingReferral => r !== undefined)
		.map((r) => ({ referredPersonaId: r.referredPersonaId }));

	const sharedFiles = [...new Set(coerceHandles(parsed?.send_files))]
		.map((handle) => fileByHandle.get(handle))
		.filter((f): f is PendingFile => f !== undefined)
		.map((f) => ({ fileId: f.fileId }));

	await ctx.runMutation(internal.api.turn.applyDecisions, {
		runId,
		personaId,
		message,
		reply,
		unlockedReferrals,
		sharedFiles,
		turnId,
	});
}
