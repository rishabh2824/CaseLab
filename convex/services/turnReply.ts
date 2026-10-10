import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import {
	classifyHarassment,
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
import type { PersonaPayload } from "../models/cases";
import { graphReferrals, type PersonaGraph } from "./simulationReads";

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
export async function buildTurnContext(
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

// Generates the persona reply for a job and saves it, or saves a boundary reply if the message was flagged.
export async function generateReply(
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
		await ctx.runMutation(internal.turn.applyBoundary, {
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

	await ctx.runMutation(internal.turn.applyDecisions, {
		replyId,
		reply,
		unlockedReferrals,
		sharedFiles,
	});
}
