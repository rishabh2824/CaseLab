import type { GenericId } from "convex/values";
import { getConvexClient } from "convex-svelte";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { UserError } from "#lib/errors.js";
import type {
	CaseInfo,
	CollaboratorPayload,
	FileRefPayload,
	GraphData,
	Persona,
	PersonaPayload,
} from "../types.js";

// Requests the given number of upload URLs from Convex.
async function generateUploadUrls(count: number): Promise<string[]> {
	if (count === 0) return [];
	return await getConvexClient().mutation(api.uploads.generateUploadUrls, {
		count,
	});
}

// Uploads a file to a Convex upload URL and returns its storage reference.
async function putToConvexStorage(
	file: File,
	uploadUrl: string,
): Promise<FileRefPayload> {
	const response = await fetch(uploadUrl, {
		method: "POST",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (!response.ok) throw new UserError("Failed to upload file.");
	const { storageId } = (await response.json()) as {
		storageId: GenericId<"_storage">;
	};

	return {
		storageId: storageId,
		fileName: file.name,
		contentType: file.type || undefined,
	};
}

// Collects every new File (teaching notes, profile photos and attachments) that still needs uploading.
function collectPendingUploads(
	personas: Persona[],
	teachingNotes: File | FileRefPayload | null,
): File[] {
	const files: File[] = [];
	if (teachingNotes instanceof File) files.push(teachingNotes);
	for (const persona of personas) {
		if (persona.profilePhoto instanceof File) files.push(persona.profilePhoto);
		for (const entry of persona.files) {
			if (entry.file instanceof File) files.push(entry.file);
		}
	}
	return files;
}

// Uploads all pending files and throws if any upload fails. Files uploaded before a failure are left for the weekly sweep.
async function uploadAll(
	personas: Persona[],
	teachingNotes: File | FileRefPayload | null,
): Promise<Map<File, FileRefPayload>> {
	const pending = collectPendingUploads(personas, teachingNotes);
	const uploadUrls = await generateUploadUrls(pending.length);
	try {
		const refs = await Promise.all(
			pending.map((file, i) => putToConvexStorage(file, uploadUrls[i]!)),
		);
		return new Map(pending.map((file, i) => [file, refs[i]!]));
	} catch (err) {
		throw err instanceof UserError
			? err
			: new UserError("Failed to upload one or more files.");
	}
}

// Swaps a persona's new File objects for their uploaded references, and leaves out whatever is empty: no photo and no availability limit. Every file row has a file by now, because a case with an empty row cannot be saved.
function buildPersonaPayload(
	persona: Persona,
	uploaded: Map<File, FileRefPayload>,
): PersonaPayload {
	const { profilePhoto, availabilityMinutes, files, ...rest } = persona;
	const photo =
		profilePhoto instanceof File ? uploaded.get(profilePhoto) : profilePhoto;
	return {
		...rest,
		...(photo ? { profilePhoto: photo } : {}),
		...(availabilityMinutes !== null ? { availabilityMinutes } : {}),
		files: files.map((entry) => ({
			...entry,
			file:
				entry.file instanceof File ? uploaded.get(entry.file)! : entry.file!,
		})),
	};
}

export type SubmitCaseInput = CaseInfo &
	GraphData & {
		editCaseId: string | null;
		teachingNotes?: File | FileRefPayload | null;
		collaborators: CollaboratorPayload[];
	};

// Uploads new files then creates or updates the case.
export async function submitCase({
	editCaseId,
	duration,
	personas,
	referrals,
	teachingNotes = null,
	collaborators,
	...info
}: SubmitCaseInput): Promise<{ caseId: Id<"cases"> }> {
	const uploaded = await uploadAll(personas, teachingNotes);
	const personasPayload = personas.map((persona) =>
		buildPersonaPayload(persona, uploaded),
	);
	const scalars = {
		...info,
		duration: duration ?? undefined,
		structure: { personas: personasPayload, referrals },
		teachingNotes:
			(teachingNotes instanceof File
				? uploaded.get(teachingNotes)
				: teachingNotes) ?? undefined,
		collaborators,
	};

	if (editCaseId !== null) {
		return await getConvexClient().mutation(api.cases.update, {
			caseId: editCaseId as Id<"cases">,
			...scalars,
		});
	}

	return await getConvexClient().mutation(api.cases.create, scalars);
}
