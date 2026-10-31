import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { listCaseAuthors } from "./model/cases";
import {
	computeExpiresAt,
	flaggedCounts,
	flattenPersonas,
	isChatEnded,
	loadRun,
	referredContactIds,
} from "./model/runs";
import { STUDENT_ERROR, studentError } from "./shared/studentErrors";
import type { PersonaPayload } from "./shared/validators";

// Trims and lower-cases a student's access code.
function normalizeAccessCode(raw: string): string {
	return raw.trim().toLowerCase();
}

// Builds the student-facing contact for a persona, without exposing its secret fields.
function toContactOut(
	persona: PersonaPayload,
	photoUrl: string | null,
	isReferred: boolean,
	availableAtMinutes: number,
	warnings: number,
) {
	return {
		id: persona.id,
		name: persona.name,
		role: persona.role,
		profilePhotoUrl: photoUrl,
		availabilityDuration: persona.availabilityMinutes ?? null,
		availableAt: availableAtMinutes,
		isReferred,
		chatEnded: isChatEnded(warnings),
	};
}

// Builds the contact list from root personas followed by unlocked referred personas.
async function buildContacts(
	ctx: QueryCtx | MutationCtx,
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
			availableAt: unlockedAt[persona.id] ?? 0,
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

// Builds the student-facing shared file with its URL, or null if the upload is gone.
async function toSharedFileOut(
	ctx: QueryCtx | MutationCtx,
	storageId: Id<"_storage">,
	fileName: string | undefined,
) {
	const stored = await ctx.db.system.get("_storage", storageId);
	if (!stored) return null;
	return {
		fileId: storageId,
		fileName: fileName ?? "file",
		contentType: stored.contentType ?? null,
		url: await ctx.storage.getUrl(storageId),
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

// Turns finished and flagged turns into student and persona messages, hiding pending and failed ones.
function toChatMessages(turns: Doc<"turns">[]): ChatMessageOut[] {
	return turns
		.filter((turn) => turn.status === "done" || turn.status === "flagged")
		.flatMap((turn): ChatMessageOut[] => [
			{ role: "user", content: turn.studentMessage },
			{ role: "assistant", content: turn.reply },
		]);
}

// Starts a simulation run for an access code, schedules its destruction and returns its id.
export const start = mutation({
	args: { accessCode: v.string() },
	handler: async (
		ctx,
		{ accessCode: accessCodeRaw },
	): Promise<{ runId: Id<"runs"> }> => {
		const accessCode = normalizeAccessCode(accessCodeRaw);
		if (!accessCode)
			throw studentError(
				STUDENT_ERROR.ACCESS_CODE_REQUIRED,
				"Access code is required.",
			);
		const c = await ctx.db
			.query("cases")
			.withIndex("by_access_code", (q) => q.eq("accessCode", accessCode))
			.first();
		if (!c)
			throw studentError(
				STUDENT_ERROR.INVALID_ACCESS_CODE,
				"Invalid access code.",
			);

		const startTime = Date.now();
		const expiresAt = computeExpiresAt(startTime, c.duration);
		const runId = await ctx.db.insert("runs", {
			caseId: c._id,
			expiresAt,
			unlockedAt: {},
			sharedFiles: [],
		});
		await ctx.scheduler.runAt(expiresAt, internal.simulations.destroy, {
			runId,
		});

		return { runId: runId };
	},
});

// Returns the current state of a run for the student view: its case summary, contacts and shared files.
export const get = query({
	args: { runId: v.id("runs") },
	handler: async (ctx, { runId }) => {
		const { run, c } = await loadRun(ctx, runId);
		const graph = flattenPersonas(c.structure);
		const contacts = await buildContacts(
			ctx,
			await flaggedCounts(ctx, runId),
			run.unlockedAt,
			graph.roots.map((id) => graph.personas.get(id)!),
			referredContactIds(graph, Object.keys(run.unlockedAt)).map(
				(id) => graph.personas.get(id)!,
			),
		);
		const fileNames = new Map(
			c.structure.personas.flatMap((persona) =>
				persona.files.map(
					(entry) => [entry.file.storageId, entry.file.fileName] as const,
				),
			),
		);
		const sharedFiles = (
			await Promise.all(
				run.sharedFiles.map((storageId) =>
					toSharedFileOut(ctx, storageId, fileNames.get(storageId)),
				),
			)
		).filter((file) => file !== null);

		return {
			runId: runId,
			case: {
				id: c._id,
				caseName: c.name,
				brief: c.brief,
				simulationDuration: c.duration ?? null,
				authors: await listCaseAuthors(ctx, c),
			},
			contacts,
			sharedFiles: sharedFiles,
		};
	},
});

// Returns the chat history between the student and one persona, plus the state of the latest reply.
export const getPersonaHistory = query({
	args: { runId: v.id("runs"), personaId: v.string() },
	handler: async (ctx, { runId, personaId }) => {
		const turns = await queryPersonaTurns(ctx, runId, personaId);
		const last = turns.at(-1);
		return {
			messages: toChatMessages(turns),
			reply: last ? { id: last._id, status: last.status } : null,
		};
	},
});

// Returns every unlocked persona's transcript for export, roots first then referred by unlock time.
export const exportRun = query({
	args: { runId: v.id("runs") },
	handler: async (ctx, { runId }) => {
		const { run, c } = await loadRun(ctx, runId);
		const graph = flattenPersonas(c.structure);
		const referredIds = referredContactIds(
			graph,
			Object.keys(run.unlockedAt),
		).sort((a, b) => (run.unlockedAt[a] ?? 0) - (run.unlockedAt[b] ?? 0));
		const personaIds = [...graph.roots, ...referredIds];

		const personas = await Promise.all(
			personaIds.map(async (personaId) => {
				const persona = graph.personas.get(personaId)!;
				const turns = await queryPersonaTurns(ctx, runId, personaId);
				return {
					id: personaId,
					name: persona.name,
					role: persona.role,
					messages: toChatMessages(turns),
				};
			}),
		);

		return { case: { id: c._id, caseName: c.name }, personas };
	},
});

// Deletes a run together with its turns; safe to call on a missing run (scheduled when the run starts).
export const destroy = internalMutation({
	args: { runId: v.id("runs") },
	handler: async (ctx, { runId }) => {
		if ((await ctx.db.get("runs", runId)) === null) return;

		const turns = await ctx.db
			.query("turns")
			.withIndex("by_run_persona", (q) => q.eq("runId", runId))
			.collect();
		for (const turn of turns) await ctx.db.delete("turns", turn._id);

		await ctx.db.delete("runs", runId);
	},
});
