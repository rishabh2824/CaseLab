// Node project: submitCase orchestrates the two-phase direct-to-Convex-storage upload
// (generate an upload URL, then POST straight to it) and builds the case create/update
// payload. Nothing else exercises it, and a silent field-mapping bug here (e.g. an uploaded
// storage id landing on the wrong persona) would corrupt a saved case without ever throwing.
//
// Both create/update and upload-url generation go through Convex (getConvexClient().mutation,
// mocked below) -- only the storage POST itself stays real MSW/fetch.
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

// This file's "server" vitest project doesn't set clearMocks (only "client" does, see
// vite.config.ts) -- reset call history and implementations ourselves so one test's
// mockMutation setup can't leak into the next.
beforeEach(() => {
	mockMutation.mockReset();
});

// Node's built-in fetch (bundled undici) refuses a relative URL outright — it
// needs a same-origin base to resolve against, which a browser gets for free
// from `location`. Mirrors client.test.ts's identical patch so apiFetch's
// `fetch("/api/...")` calls resolve here the same way they would in a browser.
// (The direct-to-storage POST below uses an absolute URL, so it needs no such
// patch.)
Object.defineProperty(globalThis, Symbol.for("undici.globalOrigin.1"), {
	value: new URL("http://localhost"),
	writable: true,
	enumerable: false,
	configurable: true,
});

const UPLOAD_ORIGIN = "https://upload.test";

// Wires generateUploadUrls (mutation, args `{count}`), createCase/updateCase (mutation, args
// distinguished by whether `caseId` is present -- same as submitCase itself building update's
// args from create's `scalars` plus that one extra field), and the storage POST each upload
// URL hands back. `postStatus` lets the upload-failure test reuse this without hand-rolling
// its own handlers. All three go through the same mocked `mutation()`, so they're wired
// together in one place instead of independent stubs.
function stubMutations({ postStatus = 200 }: { postStatus?: number } = {}) {
	const uploadCountRequests: number[] = [];
	const postRequests: { url: string; contentType: string | null }[] = [];
	const createRequests: Record<string, unknown>[] = [];
	const updateRequests: Record<string, unknown>[] = [];
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
	};
}

function baseInput(overrides: Partial<SubmitCaseInput> = {}): SubmitCaseInput {
	return {
		isEditMode: false,
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
	it("creates a case via the Convex createCase mutation", async () => {
		const { createRequests } = stubMutations();

		await submitCase(baseInput());

		expect(createRequests).toHaveLength(1);
		expect(mockMutation).toHaveBeenCalledTimes(1);
	});

	it("updates a case via the Convex updateCase mutation, passing its caseId", async () => {
		const { updateRequests } = stubMutations();

		await submitCase(baseInput({ isEditMode: true, editCaseId: "42" }));

		expect(updateRequests).toHaveLength(1);
		expect(updateRequests[0]?.caseId).toBe("42");
		expect(mockMutation).toHaveBeenCalledTimes(1);
	});
});

describe("submitCase — profile photo upload", () => {
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

	it("passes an existing FileRef profile photo through without uploading it again", async () => {
		const { uploadCountRequests, createRequests } = stubMutations();
		const existingPhoto: FileRefPayload = {
			storage_id: "storage-existing" as GenericId<"_storage">,
			file_name: "old.png",
			content_type: "image/png",
		};
		const persona = makePersona({ profile_photo: existingPhoto });

		await submitCase(baseInput({ personas: [persona] }));

		// The whole point: an already-uploaded photo must not hit generateUploadUrls again.
		expect(uploadCountRequests).toEqual([]);
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.profile_photo).toEqual(existingPhoto);
	});

	// Regression test: a case saved under an older version of this app can have a
	// `file_id` key on its stored profile_photo that the current fileRefValidator
	// (convex/models/cases.ts) no longer allows -- getForEdit/a template load returns it
	// exactly as stored, and passing it straight through crashed create/update with
	// "Value does not match validator" instead of anything an admin could act on.
	it("drops unrecognized keys (e.g. a stale file_id) from an existing profile photo", async () => {
		const { createRequests } = stubMutations();
		const legacyPhoto = {
			storage_id: "storage-existing" as GenericId<"_storage">,
			file_name: "old.png",
			content_type: "image/png",
			file_id: "stale-files-row-id",
		} as FileRefPayload;
		const persona = makePersona({ profile_photo: legacyPhoto });

		await submitCase(baseInput({ personas: [persona] }));

		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.profile_photo).toEqual({
			storage_id: "storage-existing",
			file_name: "old.png",
			content_type: "image/png",
		});
	});
});

describe("submitCase — file attachments", () => {
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

	// Same legacy-shape hazard as the profile photo test above -- an existing attachment
	// round-tripped through getForEdit/a template load can carry a stale `file_id` too.
	it("drops unrecognized keys (e.g. a stale file_id) from an existing attachment", async () => {
		const { createRequests } = stubMutations();
		const legacyFile = {
			storage_id: "storage-existing" as GenericId<"_storage">,
			file_name: "invoice.xlsx",
			content_type: "application/vnd.ms-excel",
			file_id: "stale-files-row-id",
		} as FileRefPayload;
		const persona = makePersona({
			files: [
				{
					file: legacyFile,
					share_conditions: "always",
					perceived_contents: "",
				},
			],
		});

		await submitCase(baseInput({ personas: [persona] }));

		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.files?.[0]?.file).toEqual({
			storage_id: "storage-existing",
			file_name: "invoice.xlsx",
			content_type: "application/vnd.ms-excel",
		});
	});
});

describe("submitCase — content type handling", () => {
	it("sends application/octet-stream on the upload POST for a file with no MIME type", async () => {
		const { postRequests } = stubMutations();
		// No `type` option — a real drag-and-dropped file of an unrecognized kind
		// behaves exactly like this (file.type === "").
		const persona = makePersona({
			profile_photo: new File(["data"], "note"),
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(postRequests).toHaveLength(1);
		expect(postRequests[0]?.contentType).toBe("application/octet-stream");
	});
});

describe("submitCase — multiple personas and attachments", () => {
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

		// 4 uploads total: p1's photo + 2 files, p2's 1 file — sent as a single
		// batched generateUploadUrls call, not 4 separate round trips. Runs through
		// Promise.all in uploadAll, so the count alone would not catch a
		// mis-association — the per-persona checks below do.
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

		// Every storage id is unique — a mis-mapped id would silently overwrite
		// one persona's file with another's, so uniqueness alone is a real check.
		const allIds = [
			sentP1?.profile_photo?.storage_id,
			...(sentP1?.files ?? []).map((f) => f.file?.storage_id),
			...(sentP2?.files ?? []).map((f) => f.file?.storage_id),
		];
		expect(new Set(allIds).size).toBe(allIds.length);
	});
});

describe("submitCase — upload failures", () => {
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
});

describe("submitCase — payload shaping", () => {
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
		// Reduced to exactly {from_id, to_id, conditions} — conditions itself is
		// passed through untrimmed, only the top-level case fields are trimmed.
		expect(body.referrals).toEqual([
			{ from_id: "p1", to_id: "p2", conditions: "  when asked  " },
		]);
		expect(body.roots).toEqual(["p1"]);
		expect(body.collaboratorAdminIds).toEqual(["admin2", "admin5"]);
	});
});
