import { ConvexError, type GenericId } from "convex/values";
import { getConvexClient } from "convex-svelte";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
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
	if (!response.ok) throw new ConvexError("Failed to upload file.");
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

// Uploads all pending files, discarding the successful ones and throwing if any upload fails.
async function uploadAll(
	personas: Persona[],
	teachingNotes: File | FileRefPayload | null,
): Promise<Map<File, FileRefPayload>> {
	const pending = collectPendingUploads(personas, teachingNotes);
	const uploadUrls = await generateUploadUrls(pending.length);
	const settled = await Promise.allSettled(
		pending.map((file, i) => putToConvexStorage(file, uploadUrls[i] as string)),
	);
	const succeeded = new Map<File, FileRefPayload>();
	const failures: unknown[] = [];
	settled.forEach((result, i) => {
		if (result.status === "fulfilled") {
			succeeded.set(pending[i] as File, result.value);
		} else {
			failures.push(result.reason);
		}
	});
	if (failures.length > 0) {
		await discardNewUploads(succeeded);
		const firstFailure = failures[0];
		throw firstFailure instanceof ConvexError
			? firstFailure
			: new ConvexError("Failed to upload one or more files.");
	}
	return succeeded;
}

// Swaps a persona's new File objects for their uploaded references, and leaves out whatever is empty: no photo, no availability limit, and file rows without a file.
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
		files: files.flatMap((entry) => {
			const file =
				entry.file instanceof File ? uploaded.get(entry.file) : entry.file;
			return file ? [{ ...entry, file }] : [];
		}),
	};
}

// Deletes freshly uploaded files from storage, ignoring any errors.
async function discardNewUploads(
	uploaded: Map<File, FileRefPayload>,
): Promise<void> {
	if (uploaded.size === 0) return;
	const storageIds = [...uploaded.values()].map((ref) => ref.storageId);
	try {
		await getConvexClient().mutation(api.uploads.discardUploads, {
			storageIds,
		});
	} catch {}
}

export type SubmitCaseInput = CaseInfo &
	GraphData & {
		editCaseId: string | null;
		teachingNotes?: File | FileRefPayload | null;
		collaborators: CollaboratorPayload[];
	};

// Uploads new files then creates or updates the case, discarding the uploads if the save fails.
export async function submitCase({
	editCaseId,
	caseName,
	initialBrief,
	commonInformation,
	simulationDurationMinutes,
	accessCode,
	personas,
	referrals,
	teachingNotes = null,
	collaborators,
}: SubmitCaseInput): Promise<{ caseId: Id<"cases"> }> {
	const uploaded = await uploadAll(personas, teachingNotes);
	const personasPayload = personas.map((persona) =>
		buildPersonaPayload(persona, uploaded),
	);
	const scalars = {
		name: caseName,
		brief: initialBrief,
		commonInformation,
		duration: simulationDurationMinutes ?? undefined,
		accessCode,
		structure: { personas: personasPayload, referrals },
		teachingNotes:
			(teachingNotes instanceof File
				? uploaded.get(teachingNotes)
				: teachingNotes) ?? undefined,
		collaborators,
	};

	try {
		if (editCaseId !== null) {
			return await getConvexClient().mutation(api.cases.update, {
				caseId: editCaseId as Id<"cases">,
				...scalars,
			});
		}

		return await getConvexClient().mutation(api.cases.create, scalars);
	} catch (err) {
		await discardNewUploads(uploaded);
		throw err;
	}
}
