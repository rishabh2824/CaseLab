import { makeFunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import { getConvexClient } from "convex-svelte";
import type {
	FileRefPayload,
	Persona,
	PersonaPayload,
	ReferralEdge,
} from "../types.js";
import { normalizePersona } from "./draft.js";

// String-based references (not generated `api` imports): the convex/ project lives at
// the repo root, outside this Vite project's root -- see AdminAuth.svelte for why.
const generateUploadUrlsRef = makeFunctionReference<"mutation">(
	"api/uploads:generateUploadUrls",
);
const createCaseRef = makeFunctionReference<"mutation">("api/cases:create");
const updateCaseRef = makeFunctionReference<"mutation">("api/cases:update");

// Where one File-valued upload slot (a persona's profile photo, or one of its
// attachments) lives in the persona list, so results can be matched back
// after uploading every file concurrently.
type UploadTarget =
	| { kind: "photo"; personaIndex: number }
	| { kind: "file"; personaIndex: number; fileIndex: number };

type PendingUpload = {
	target: UploadTarget;
	file: File;
};

// One request for every File across every persona (photos and attachments alike) -- not
// one request per file. Shared by both the create and edit save paths below. Unlike the old
// Spaces presign (which needed each file's name/content type/prefix to sign a matching PUT
// URL), a Convex upload URL carries none of that -- it's generated and consumed once, with
// the file's own metadata attached separately when Convex resolves the upload -- so this is
// just "give me N URLs," paying the admin auth check once per case save instead of once per
// file.
async function generateUploadUrls(count: number): Promise<string[]> {
	if (count === 0) return [];
	return await getConvexClient().mutation(generateUploadUrlsRef, { count });
}

async function putToConvexStorage(
	file: File,
	uploadUrl: string,
): Promise<FileRefPayload> {
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
		storage_id: storageId,
		file_name: file.name,
		content_type: file.type || undefined,
	};
}

function targetKey(target: UploadTarget): string {
	return target.kind === "photo"
		? `photo:${target.personaIndex}`
		: `file:${target.personaIndex}:${target.fileIndex}`;
}

// Uploads every File-valued profile photo/attachment across every persona: one round trip
// for the whole batch's upload URLs, then every upload running concurrently (not
// photo-then-attachments, persona by persona in series).
async function uploadAll(
	personas: Persona[],
): Promise<Map<string, FileRefPayload>> {
	const uploads: PendingUpload[] = [];
	personas.forEach((persona, personaIndex) => {
		if (persona.profile_photo instanceof File) {
			uploads.push({
				target: { kind: "photo", personaIndex },
				file: persona.profile_photo,
			});
		}
		persona.files.forEach((entry, fileIndex) => {
			if (entry.file instanceof File) {
				uploads.push({
					target: { kind: "file", personaIndex, fileIndex },
					file: entry.file,
				});
			}
		});
	});

	// Consumed as a queue (not indexed by position) so each pairing is
	// type-narrowed by its own `if (!x) throw` rather than a
	// `string | undefined` from indexing uploadUrls[i]
	// (noUncheckedIndexedAccess) that a separate length check can't narrow away.
	const uploadUrlQueue = await generateUploadUrls(uploads.length);
	const pairs = uploads.map((upload) => {
		const uploadUrl = uploadUrlQueue.shift();
		if (!uploadUrl) throw new Error("Missing upload URL for an upload.");
		return { upload, uploadUrl };
	});
	const refPairs = await Promise.all(
		pairs.map(async ({ upload, uploadUrl }) => ({
			target: upload.target,
			ref: await putToConvexStorage(upload.file, uploadUrl),
		})),
	);

	const results = new Map<string, FileRefPayload>();
	refPairs.forEach(({ target, ref }) => {
		results.set(targetKey(target), ref);
	});
	return results;
}

function buildPersonaPayload(
	persona: Persona,
	personaIndex: number,
	uploaded: Map<string, FileRefPayload>,
): PersonaPayload {
	const profile_photo =
		persona.profile_photo instanceof File
			? (uploaded.get(targetKey({ kind: "photo", personaIndex })) ?? null)
			: persona.profile_photo;
	const files = persona.files.map((entry, fileIndex) => {
		if (!entry.file) return { ...entry, file: null };
		if (entry.file instanceof File) {
			return {
				...entry,
				file:
					uploaded.get(targetKey({ kind: "file", personaIndex, fileIndex })) ??
					null,
			};
		}
		return { ...entry, file: entry.file };
	});
	return {
		id: persona.id,
		name: persona.name,
		role: persona.role,
		profile_photo,
		known_facts: persona.known_facts,
		personality_traits: persona.personality_traits,
		availability_minutes: persona.availability_minutes,
		files,
	};
}

export type SubmitCaseInput = {
	isEditMode: boolean;
	editCaseId?: string | null;
	caseName: string;
	initialBrief: string;
	commonInformation: string;
	simulationDurationMinutes: number | null;
	accessCode: string;
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
	// Convex admin ids (see CaseForm.svelte's collaborator picker, now sourced from
	// api/admins:listAll rather than the old backend's numeric ids).
	collaboratorAdminIds: string[];
};

// Uploads any new (File-valued) profile photos/attachments to Convex storage, then creates
// or updates the case -- both go through Convex end to end now. Edit has no optimistic-
// concurrency check (no expected-version conflict to handle): two admins saving the same
// case at once is rare enough that last-write-wins is an accepted tradeoff (see
// backend/convex/schema.ts's comment on `cases`).
export async function submitCase({
	isEditMode,
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
}: SubmitCaseInput): Promise<unknown> {
	const normalizedPersonas = personas.map((persona) =>
		normalizePersona(persona),
	);
	const uploaded = await uploadAll(normalizedPersonas);
	const personasPayload = normalizedPersonas.map((persona, personaIndex) =>
		buildPersonaPayload(persona, personaIndex, uploaded),
	);
	const referralsPayload = referrals.map((referral) => ({
		from_id: referral.from_id,
		to_id: referral.to_id,
		conditions: referral.conditions,
	}));

	const scalars = {
		name: caseName.trim(),
		brief: initialBrief.trim(),
		commonInformation: commonInformation.trim(),
		duration: simulationDurationMinutes ?? undefined,
		accessCode: accessCode.trim(),
		personas: personasPayload,
		referrals: referralsPayload,
		roots,
		collaboratorAdminIds,
	};

	if (isEditMode) {
		// editCaseId is always set by the time submitCase can run in edit mode -- the
		// submit button stays disabled until loadCase resolves (see CaseForm.svelte).
		return getConvexClient().mutation(updateCaseRef, {
			caseId: editCaseId as string,
			...scalars,
		});
	}

	return getConvexClient().mutation(createCaseRef, scalars);
}
