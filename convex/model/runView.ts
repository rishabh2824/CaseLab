import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { FileRefPayload, PersonaPayload } from "../shared/validators";
import { listCaseAuthors } from "./caseLists";
import { flaggedCounts, isChatEnded } from "./flags";
import { flattenPersonas } from "./personaGraph";
import { loadRun } from "./runs";

// Builds the student-facing contact for a persona, without exposing its secret fields.
function toContactOut(
	persona: PersonaPayload,
	photoUrl: string | null,
	isReferred: boolean,
	availableAtMinutes: number,
	flagCount: number,
) {
	return {
		id: persona.id,
		name: persona.name,
		role: persona.role,
		profilePhotoUrl: photoUrl,
		availabilityDuration: persona.availabilityMinutes ?? null,
		availableAt: availableAtMinutes,
		isReferred,
		chatEnded: isChatEnded(flagCount),
	};
}

// Builds the contact list from root personas followed by unlocked referred personas.
async function buildContacts(
	ctx: QueryCtx,
	flagged: Map<string, number>,
	unlockedAt: Record<string, number>,
	rootPersonas: PersonaPayload[],
	referredPersonas: PersonaPayload[],
) {
	const entries = [
		...rootPersonas.map((persona) => ({
			persona,
			availableAt: 0,
			isReferred: false,
		})),
		...referredPersonas.map((persona) => ({
			persona,
			availableAt: unlockedAt[persona.id]!,
			isReferred: true,
		})),
	];
	return await Promise.all(
		entries.map(async ({ persona, availableAt, isReferred }) =>
			toContactOut(
				persona,
				persona.profilePhoto
					? await ctx.storage.getUrl(persona.profilePhoto.storageId)
					: null,
				isReferred,
				availableAt,
				flagged.get(persona.id) ?? 0,
			),
		),
	);
}

// Builds the student-facing shared file with its URL.
async function toSharedFileOut(ctx: QueryCtx, file: FileRefPayload) {
	return {
		fileId: file.storageId,
		fileName: file.fileName,
		contentType: file.contentType ?? null,
		url: await ctx.storage.getUrl(file.storageId),
	};
}

type ChatMessageOut = { role: "user" | "assistant"; content: string };

// Loads a persona's turns for a run, oldest first.
async function queryPersonaTurns(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
): Promise<Doc<"turns">[]> {
	return await ctx.db
		.query("turns")
		.withIndex("by_run_persona", (q) =>
			q.eq("runId", runId).eq("personaId", personaId),
		)
		.collect();
}

// Turns finished and flagged turns into student and persona messages. With showPending, a pending turn shows just the student's message so it appears the moment it is sent; failed turns are always hidden because the message goes back to the composer.
function toChatMessages(
	turns: Doc<"turns">[],
	showPending: boolean,
): ChatMessageOut[] {
	return turns.flatMap((turn): ChatMessageOut[] => {
		const student: ChatMessageOut = {
			role: "user",
			content: turn.studentMessage,
		};
		if (turn.status === "pending") return showPending ? [student] : [];
		if (turn.status === "done" || turn.status === "flagged")
			return [student, { role: "assistant", content: turn.reply }];
		return [];
	});
}

// Returns the current state of a run for the student view: its case summary, contacts and shared files.
export async function getRunView(ctx: QueryCtx, runId: Id<"runs">) {
	const { run, c } = await loadRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const contacts = await buildContacts(
		ctx,
		await flaggedCounts(ctx, runId),
		run.unlockedAt,
		graph.roots.map((id) => graph.personas.get(id)!),
		Object.keys(run.unlockedAt).map((id) => graph.personas.get(id)!),
	);
	const fileRefs = new Map(
		c.structure.personas.flatMap((persona) =>
			persona.files.map((entry) => [entry.file.storageId, entry.file] as const),
		),
	);
	const sharedFiles = await Promise.all(
		run.sharedFiles.map((storageId) =>
			toSharedFileOut(ctx, fileRefs.get(storageId)!),
		),
	);

	return {
		runId,
		case: {
			id: c._id,
			name: c.name,
			brief: c.brief,
			duration: c.duration ?? null,
			authors: await listCaseAuthors(ctx, c),
		},
		contacts,
		sharedFiles,
	};
}

// Returns the chat history between the student and one persona, the state of the latest reply, and the student's last message when its reply failed.
export async function getPersonaHistoryView(
	ctx: QueryCtx,
	runId: Id<"runs">,
	personaId: string,
) {
	const turns = await queryPersonaTurns(ctx, runId, personaId);
	const last = turns.at(-1);
	return {
		messages: toChatMessages(turns, true),
		reply: last ? { id: last._id, status: last.status } : null,
		failedMessage: last?.status === "failed" ? last.studentMessage : null,
	};
}

// Returns every unlocked persona's transcript for export, roots first then referred by unlock time.
export async function exportRunView(ctx: QueryCtx, runId: Id<"runs">) {
	const { run, c } = await loadRun(ctx, runId);
	const graph = flattenPersonas(c.structure);
	const referredIds = Object.keys(run.unlockedAt).sort(
		(a, b) => run.unlockedAt[a]! - run.unlockedAt[b]!,
	);
	const personaIds = [...graph.roots, ...referredIds];

	const personas = await Promise.all(
		personaIds.map(async (personaId) => {
			const persona = graph.personas.get(personaId)!;
			const turns = await queryPersonaTurns(ctx, runId, personaId);
			return {
				id: personaId,
				name: persona.name,
				role: persona.role,
				messages: toChatMessages(turns, false),
			};
		}),
	);

	return { case: { id: c._id, name: c.name }, personas };
}
