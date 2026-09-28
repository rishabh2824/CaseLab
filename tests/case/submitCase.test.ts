import type { GenericId } from "convex/values";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SubmitCaseInput,
	submitCase,
} from "../../src/lib/case/submitCase.js";
import type { FileRefPayload, PersonaPayload } from "../../src/lib/types.js";
import { makePersona } from "../support/fixtures.js";
import { server } from "../support/msw.js";

const mockMutation = vi.fn();

vi.mock("convex-svelte", () => ({
	getConvexClient: () => ({ mutation: mockMutation }),
}));

beforeEach(() => {
	mockMutation.mockReset();
});

Object.defineProperty(globalThis, Symbol.for("undici.globalOrigin.1"), {
	value: new URL("http://localhost"),
	writable: true,
	enumerable: false,
	configurable: true,
});

const UPLOAD_ORIGIN = "https://upload.test";

// Stubs the Convex mutations and storage uploads and records the requests made.
function stubMutations({
	postStatus = 200,
	failSave,
}: {
	postStatus?: number;
	failSave?: Error;
} = {}) {
	const uploadCountRequests: number[] = [];
	const postRequests: { url: string; contentType: string | null }[] = [];
	const createRequests: Record<string, unknown>[] = [];
	const updateRequests: Record<string, unknown>[] = [];
	const discardRequests: unknown[][] = [];
	let counter = 0;

	mockMutation.mockImplementation(
		async (_ref: unknown, args: Record<string, unknown>) => {
			if ("count" in args) {
				const count = args.count as number;
				uploadCountRequests.push(count);
				return Array.from({ length: count }, () => {
					counter += 1;
					return `${UPLOAD_ORIGIN}/upload/${counter}`;
				});
			}
			if ("storageIds" in args) {
				discardRequests.push(args.storageIds as unknown[]);
				return null;
			}
			if (failSave) throw failSave;
			if ("caseId" in args) {
				updateRequests.push(args);
				return { caseId: args.caseId };
			}
			createRequests.push(args);
			return { caseId: "convex-case-id" };
		},
	);

	server.use(
		http.post(`${UPLOAD_ORIGIN}/*`, ({ request }) => {
			postRequests.push({
				url: request.url,
				contentType: request.headers.get("content-type"),
			});
			if (postStatus !== 200)
				return new HttpResponse(null, { status: postStatus });
			const storageId = request.url.split("/").pop();
			return HttpResponse.json({ storageId: `storage-${storageId}` });
		}),
	);

	return {
		uploadCountRequests,
		postRequests,
		createRequests,
		updateRequests,
		discardRequests,
	};
}

// Builds a submitCase input with defaults and optional overrides.
function baseInput(overrides: Partial<SubmitCaseInput> = {}): SubmitCaseInput {
	return {
		editCaseId: null,
		caseName: "Sterling Industries",
		initialBrief: "Reduce office supply costs.",
		commonInformation: "Background context.",
		simulationDurationMinutes: 45,
		accessCode: "abc",
		personas: [],
		referrals: [],
		roots: [],
		collaboratorAdminIds: [],
		...overrides,
	};
}

describe("submitCase — create vs. edit routing", () => {
	// Tests that a new case is saved through the createCase mutation.
	it("creates a case via the Convex createCase mutation", async () => {
		const { createRequests } = stubMutations();

		await submitCase(baseInput());

		expect(createRequests).toHaveLength(1);
		expect(mockMutation).toHaveBeenCalledTimes(1);
	});

	// Tests that an existing case is saved through updateCase with its caseId.
	it("updates a case via the Convex updateCase mutation, passing its caseId", async () => {
		const { updateRequests } = stubMutations();

		await submitCase(baseInput({ editCaseId: "42" }));

		expect(updateRequests).toHaveLength(1);
		expect(updateRequests[0]?.caseId).toBe("42");
		expect(mockMutation).toHaveBeenCalledTimes(1);
	});
});

describe("submitCase — profile photo upload", () => {
	// Tests that a File profile photo is uploaded and replaced with the returned file reference.
	it("uploads a File-valued profile photo and replaces it with the returned FileRef", async () => {
		const { uploadCountRequests, createRequests } = stubMutations();
		const persona = makePersona({
			id: "p1",
			profile_photo: new File(["binary"], "mary.png", { type: "image/png" }),
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(uploadCountRequests).toEqual([1]);
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.profile_photo).toEqual({
			storage_id: "storage-1",
			file_name: "mary.png",
			content_type: "image/png",
		});
	});

	// Tests that an already-uploaded profile photo reference is passed through without re-uploading.
	it("passes an existing FileRef profile photo through without uploading it again", async () => {
		const { uploadCountRequests, createRequests } = stubMutations();
		const existingPhoto: FileRefPayload = {
			storage_id: "storage-existing" as GenericId<"_storage">,
			file_name: "old.png",
			content_type: "image/png",
		};
		const persona = makePersona({ profile_photo: existingPhoto });

		await submitCase(baseInput({ personas: [persona] }));

		expect(uploadCountRequests).toEqual([]);
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.profile_photo).toEqual(existingPhoto);
	});
});

describe("submitCase — file attachments", () => {
	// Tests that a File attachment is uploaded and replaced with a reference, keeping its other fields.
	it("uploads a File-valued attachment, replacing it with a FileRef while keeping its other fields", async () => {
		const { uploadCountRequests, createRequests } = stubMutations();
		const persona = makePersona({
			files: [
				{
					file: new File(["data"], "budget.pdf", { type: "application/pdf" }),
					share_conditions: "always",
					perceived_contents: "budget",
				},
			],
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(uploadCountRequests).toEqual([1]);
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		const sentFile = personas[0]?.files?.[0];
		expect(sentFile?.file).toEqual({
			storage_id: "storage-1",
			file_name: "budget.pdf",
			content_type: "application/pdf",
		});
		expect(sentFile?.share_conditions).toBe("always");
		expect(sentFile?.perceived_contents).toBe("budget");
	});

	// Tests that an attachment with a null file is kept as-is without an upload.
	it("preserves a file:null attachment entry as-is, uploading nothing for it", async () => {
		const { uploadCountRequests, createRequests } = stubMutations();
		const persona = makePersona({
			files: [
				{ file: null, share_conditions: "never", perceived_contents: "" },
			],
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(uploadCountRequests).toEqual([]);
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.files?.[0]?.file).toBeNull();
	});
});

describe("submitCase — content type handling", () => {
	// Tests that a file with no MIME type is uploaded as application/octet-stream.
	it("sends application/octet-stream on the upload POST for a file with no MIME type", async () => {
		const { postRequests } = stubMutations();
		const persona = makePersona({
			profile_photo: new File(["data"], "note"),
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(postRequests).toHaveLength(1);
		expect(postRequests[0]?.contentType).toBe("application/octet-stream");
	});
});

describe("submitCase — multiple personas and attachments", () => {
	// Tests that every File across personas and attachments is uploaded and matched to the right entry.
	it("uploads every File across personas/attachments and associates each returned storage id with the right entry", async () => {
		const { uploadCountRequests, createRequests } = stubMutations();
		const persona1 = makePersona({
			id: "p1",
			profile_photo: new File(["a"], "p1-photo.png", { type: "image/png" }),
			files: [
				{
					file: new File(["b"], "p1-file1.pdf", { type: "application/pdf" }),
					share_conditions: "",
					perceived_contents: "",
				},
				{
					file: new File(["c"], "p1-file2.pdf", { type: "application/pdf" }),
					share_conditions: "",
					perceived_contents: "",
				},
			],
		});
		const persona2 = makePersona({
			id: "p2",
			files: [
				{
					file: new File(["d"], "p2-file1.pdf", { type: "application/pdf" }),
					share_conditions: "",
					perceived_contents: "",
				},
			],
		});

		await submitCase(baseInput({ personas: [persona1, persona2] }));

		expect(uploadCountRequests).toEqual([4]);
		expect(createRequests).toHaveLength(1);
		const sentPersonas = (createRequests[0]?.personas ??
			[]) as PersonaPayload[];
		const sentP1 = sentPersonas.find((p) => p.id === "p1");
		const sentP2 = sentPersonas.find((p) => p.id === "p2");

		expect(sentP1?.profile_photo?.file_name).toBe("p1-photo.png");
		expect((sentP1?.files ?? []).map((f) => f.file?.file_name).sort()).toEqual([
			"p1-file1.pdf",
			"p1-file2.pdf",
		]);
		expect(sentP2?.files?.[0]?.file?.file_name).toBe("p2-file1.pdf");

		const allIds = [
			sentP1?.profile_photo?.storage_id,
			...(sentP1?.files ?? []).map((f) => f.file?.storage_id),
			...(sentP2?.files ?? []).map((f) => f.file?.storage_id),
		];
		expect(new Set(allIds).size).toBe(allIds.length);
	});
});

describe("submitCase — upload failures", () => {
	// Tests that a failed storage upload rejects with an upload error and never creates the case.
	it("rejects with 'Failed to upload file.' and never creates the case when the storage POST fails", async () => {
		const { createRequests } = stubMutations({ postStatus: 500 });
		const persona = makePersona({
			profile_photo: new File(["a"], "photo.png", { type: "image/png" }),
		});

		await expect(
			submitCase(baseInput({ personas: [persona] })),
		).rejects.toThrow("Failed to upload file.");
		expect(createRequests).toHaveLength(0);
	});

	// Tests that a failed generateUploadUrls call is propagated and the case is never created.
	it("propagates a failed generateUploadUrls call, never creating the case", async () => {
		mockMutation.mockRejectedValue(new Error("Upload URL request failed."));
		const persona = makePersona({
			profile_photo: new File(["a"], "photo.png", { type: "image/png" }),
		});

		const err = await submitCase(baseInput({ personas: [persona] })).catch(
			(e) => e,
		);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("Upload URL request failed.");
	});

	// Tests that uploads are discarded when the save itself fails.
	it("cleans up its own uploads via discardUploads when the save itself fails", async () => {
		const { createRequests, discardRequests } = stubMutations({
			failSave: new Error(
				"An access code with this value already exists on another case.",
			),
		});
		const persona = makePersona({
			profile_photo: new File(["a"], "photo.png", { type: "image/png" }),
		});

		await expect(
			submitCase(baseInput({ personas: [persona] })),
		).rejects.toThrow(
			"An access code with this value already exists on another case.",
		);
		expect(createRequests).toHaveLength(0);
		expect(discardRequests).toEqual([["storage-1"]]);
	});

	// Tests that discardUploads is called with no ids when the save fails but nothing was uploaded.
	it("calls discardUploads with nothing when the save fails but nothing was uploaded", async () => {
		const { discardRequests } = stubMutations({
			failSave: new Error("Case name is required."),
		});

		await expect(submitCase(baseInput())).rejects.toThrow(
			"Case name is required.",
		);
		expect(discardRequests).toEqual([]);
	});

	// Tests that only the uploads that already succeeded are discarded when a later upload fails.
	it("discards only the uploads that already succeeded when a later upload in the same batch fails", async () => {
		const { createRequests, discardRequests } = stubMutations();
		server.use(
			http.post(`${UPLOAD_ORIGIN}/upload/2`, () => {
				return new HttpResponse(null, { status: 500 });
			}),
		);
		const persona1 = makePersona({
			id: "p1",
			profile_photo: new File(["a"], "p1-photo.png", { type: "image/png" }),
		});
		const persona2 = makePersona({
			id: "p2",
			profile_photo: new File(["b"], "p2-photo.png", { type: "image/png" }),
		});

		await expect(
			submitCase(baseInput({ personas: [persona1, persona2] })),
		).rejects.toThrow("Failed to upload file.");

		expect(createRequests).toHaveLength(0);
		expect(discardRequests).toEqual([["storage-1"]]);
	});
});

describe("submitCase — payload shaping", () => {
	// Tests that text fields are trimmed, referrals reduced to their wire shape, and roots/collaborators passed through.
	it("trims top-level text fields, reduces referrals to their wire shape, and passes roots/collaborator ids through unchanged", async () => {
		const { createRequests } = stubMutations();

		await submitCase(
			baseInput({
				caseName: "  Sterling Industries  ",
				initialBrief: "  Reduce office supply costs.  ",
				commonInformation: "  Background context.  ",
				accessCode: "  abc  ",
				referrals: [
					{ from_id: "p1", to_id: "p2", conditions: "  when asked  " },
				],
				roots: ["p1"],
				collaboratorAdminIds: ["admin2", "admin5"],
			}),
		);

		expect(createRequests).toHaveLength(1);
		const [body] = createRequests;
		if (!body) throw new Error("expected a captured create request");
		expect(body.name).toBe("Sterling Industries");
		expect(body.brief).toBe("Reduce office supply costs.");
		expect(body.commonInformation).toBe("Background context.");
		expect(body.accessCode).toBe("abc");
		expect(body.referrals).toEqual([
			{ from_id: "p1", to_id: "p2", conditions: "  when asked  " },
		]);
		expect(body.roots).toEqual(["p1"]);
		expect(body.collaboratorAdminIds).toEqual(["admin2", "admin5"]);
	});
});
