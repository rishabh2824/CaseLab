import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import type { PersonaPayload } from "../shared/validators";
import {
	classifyMessage,
	generatePersonaReply,
	RECENT_HISTORY_LIMIT,
} from "./llm";
import type { PersonaGraph } from "./personaGraph";
import {
	type CandidateFile,
	type CandidateReferral,
	cleanReply,
	replyInstructions,
	systemPrompt,
} from "./prompt";

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
	turnId: Id<"turns">;
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
	const pendingReferrals: PendingReferral[] = graph.referrals
		.filter(
			(referral) =>
				referral.fromId === persona.id &&
				run.unlockedAt[referral.toId] === undefined,
		)
		.map((referral) => {
			const referred = graph.personas.get(referral.toId)!;
			return {
				referredPersonaId: referral.toId,
				conditionTrigger: referral.conditions,
				referredName: referred.name,
				referredRole: referred.role,
			};
		});

	const pendingFiles: PendingFile[] = persona.files
		.filter((entry) => !run.sharedFiles.includes(entry.file.storageId))
		.map((entry) => ({
			storageId: entry.file.storageId,
			fileName: entry.file.fileName,
			shareConditions: entry.shareConditions,
			perceivedContents: entry.perceivedContents,
		}));

	const turns = await ctx.db
		.query("turns")
		.withIndex("by_run_persona", (q) =>
			q
				.eq("runId", run._id)
				.eq("personaId", persona.id)
				.lt("_creationTime", beforeCreationTime),
		)
		.filter((q) => q.eq(q.field("status"), "done"))
		.order("desc")
		.take(RECENT_HISTORY_LIMIT);
	turns.reverse();

	return {
		caseBrief: c.brief,
		commonInformation: c.commonInformation,
		persona,
		pendingReferrals,
		pendingFiles,
		decisionHistory: turns.flatMap((turn): DecisionMessage[] => [
			{ role: "user", content: turn.studentMessage },
			{ role: "assistant", content: turn.reply },
		]),
	};
}

// Generates the persona reply for a job and saves it, or flags the turn if the message was flagged.
export async function generateReply(
	ctx: ActionCtx,
	{ turnId, message, context }: ReplyJob,
): Promise<void> {
	const labelPromise = classifyMessage(message, context.decisionHistory);

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

	const generated = await generatePersonaReply(
		{ cacheable: cacheableSystemPrompt, dynamic },
		[...context.decisionHistory, { role: "user", content: message }],
	);

	if ((await labelPromise) === "flagged") {
		await ctx.runMutation(internal.turns.applyFlag, {
			turnId,
			personaName: context.persona.name,
		});
		return;
	}

	const reply = cleanReply(generated.reply);
	if (!reply) throw new Error("The reply came back empty.");

	// Handles are matched case-insensitively and each at most once.
	const handles = (list: string[]) => [
		...new Set(list.map((handle) => handle.trim().toUpperCase())),
	];
	const unlockedReferrals = handles(generated.introduce)
		.map((handle) => referralByHandle.get(handle))
		.filter((r): r is PendingReferral => r !== undefined)
		.map((r) => ({ referredPersonaId: r.referredPersonaId }));

	const sharedFiles = handles(generated.sendFiles)
		.map((handle) => fileByHandle.get(handle))
		.filter((f): f is PendingFile => f !== undefined)
		.map((f) => ({ storageId: f.storageId }));

	await ctx.runMutation(internal.turns.applyDecisions, {
		turnId,
		reply,
		unlockedReferrals,
		sharedFiles,
	});
}
