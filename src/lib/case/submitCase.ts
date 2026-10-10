import type { GenericId } from "convex/values";
import { getConvexClient } from "convex-svelte";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import type {
	FileRefPayload,
	Persona,
	PersonaPayload,
	ReferralEdge,
} from "../types.js";

type UploadedFileRef = Exclude<FileRefPayload, null>;

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
): Promise<UploadedFileRef> {
	const response = await fetch(uploadUrl, {
		method: "POST",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (!response.ok) throw new Error("Failed to upload file.");
	const { storageId } = (await response.json()) as {
		storageId: GenericId<"_storage">;
	};

	return {
		storageId: storageId,
		fileName: file.name,
		contentType: file.type || undefined,
	};
}

// Collects every new File (profile photos and attachments) that still needs uploading.
function collectPendingUploads(personas: Persona[]): File[] {
	const files: File[] = [];
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
): Promise<Map<File, UploadedFileRef>> {
	const pending = collectPendingUploads(personas);
	const uploadUrls = await generateUploadUrls(pending.length);
	const settled = await Promise.allSettled(
		pending.map((file, i) => putToConvexStorage(file, uploadUrls[i] as string)),
	);
	const succeeded = new Map<File, UploadedFileRef>();
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
		throw firstFailure instanceof Error
			? firstFailure
			: new Error("Failed to upload one or more files.");
	}
	return succeeded;
}

// Swaps a persona's new File objects for their uploaded references.
function buildPersonaPayload(
	persona: Persona,
	uploaded: Map<File, UploadedFileRef>,
): PersonaPayload {
	const profilePhoto =
		persona.profilePhoto instanceof File
			? (uploaded.get(persona.profilePhoto) ?? null)
			: persona.profilePhoto;
	const files = persona.files.map((entry) => {
		if (!(entry.file instanceof File))
			return { ...entry, file: entry.file ?? null };
		return { ...entry, file: uploaded.get(entry.file) ?? null };
	});
	return { ...persona, profilePhoto, files };
}

// Deletes freshly uploaded files from storage, ignoring any errors.
async function discardNewUploads(
	uploaded: Map<File, UploadedFileRef>,
): Promise<void> {
	if (uploaded.size === 0) return;
	const storageIds = [...uploaded.values()].map((ref) => ref.storageId);
	try {
		await getConvexClient().mutation(api.uploads.discardUploads, {
			storageIds,
		});
	} catch {}
}

export type SubmitCaseInput = {
	editCaseId: string | null;
	caseName: string;
	initialBrief: string;
	commonInformation: string;
	simulationDurationMinutes: number | null;
	accessCode: string;
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
	collaboratorAdminIds: string[];
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
	roots,
	collaboratorAdminIds,
}: SubmitCaseInput): Promise<{ caseId: Id<"cases"> }> {
	const uploaded = await uploadAll(personas);
	const personasPayload = personas.map((persona) =>
		buildPersonaPayload(persona, uploaded),
	);
	const scalars = {
		name: caseName.trim(),
		brief: initialBrief.trim(),
		commonInformation: commonInformation.trim(),
		duration: simulationDurationMinutes ?? undefined,
		accessCode: accessCode.trim(),
		structure: { personas: personasPayload, referrals, roots },
		collaboratorAdminIds: collaboratorAdminIds as Id<"admins">[],
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
