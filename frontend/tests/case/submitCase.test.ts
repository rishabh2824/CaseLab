// Node project: submitCase orchestrates the two-phase direct-to-Spaces upload
// (presign, then PUT straight to the returned URL) and builds the case
// create/update payload. Nothing else exercises it, and a silent
// field-mapping bug here (e.g. an uploaded key landing on the wrong persona)
// would corrupt a saved case without ever throwing.
//
// Both create and update go through Convex (getConvexClient().action/.mutation,
// mocked below) -- only the Spaces PUT itself stays real MSW/fetch.
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SubmitCaseInput,
	submitCase,
} from "../../src/lib/case/submitCase.js";
import type { FileRefPayload, PersonaPayload } from "../../src/lib/types.js";
import { makePersona } from "../support/fixtures.js";
import { server } from "../support/msw.js";

const mockAction = vi.fn();
const mockMutation = vi.fn();

vi.mock("convex-svelte", () => ({
	getConvexClient: () => ({ action: mockAction, mutation: mockMutation }),
}));

// This file's "server" vitest project doesn't set clearMocks (only "client" does, see
// vite.config.ts) -- reset call history and implementations ourselves so one test's
// mockAction/mockMutation setup can't leak into the next.
beforeEach(() => {
	mockAction.mockReset();
	mockMutation.mockReset();
});

// Node's built-in fetch (bundled undici) refuses a relative URL outright — it
// needs a same-origin base to resolve against, which a browser gets for free
// from `location`. Mirrors client.test.ts's identical patch so apiFetch's
// `fetch("/api/...")` calls resolve here the same way they would in a browser.
// (The direct-to-Spaces PUT below uses an absolute URL, so it needs no such
// patch.)
Object.defineProperty(globalThis, Symbol.for("undici.globalOrigin.1"), {
	value: new URL("http://localhost"),
	writable: true,
	enumerable: false,
	configurable: true,
});

const SPACES_ORIGIN = "https://spaces.test";

type PresignItem = { fileName: string; contentType?: string; prefix?: string };

// Wires a working batch-presign action (each call gets a unique objectKey so
// a test can verify which upload produced which key) and the Spaces PUT it
// hands back. `putStatus` lets the Spaces-failure test reuse this without
// hand-rolling its own handlers. `presignRequests` flattens every file across
// every batch call, in request order, so existing per-file assertions still
// read naturally even though submitCase sends one batched action call.
function stubUploadPipeline({ putStatus = 200 }: { putStatus?: number } = {}) {
	const presignRequests: PresignItem[] = [];
	const presignBatchCalls: PresignItem[][] = [];
	const putRequests: { url: string; contentType: string | null }[] = [];
	let counter = 0;

	mockAction.mockImplementation(async (_ref: unknown, args: { files: PresignItem[] }) => {
		presignRequests.push(...args.files);
		presignBatchCalls.push(args.files);
		return args.files.map((file) => {
			counter += 1;
			const objectKey = `objects/${counter}-${file.fileName}`;
			return {
				uploadUrl: `${SPACES_ORIGIN}/${objectKey}`,
				objectKey,
				fileName: file.fileName,
				contentType: file.contentType,
				expiresIn: 900,
			};
		});
	});

	server.use(
		http.put(`${SPACES_ORIGIN}/*`, ({ request }) => {
			putRequests.push({
				url: request.url,
				contentType: request.headers.get("content-type"),
			});
			return new HttpResponse(null, { status: putStatus });
		}),
	);

	return { presignRequests, presignBatchCalls, putRequests };
}

// Wires the Convex createCase/updateCase mutations (mocked) and captures every request
// submitCase actually sent, split by which one fired -- update's args always carry a
// `caseId`, create's never do, since submitCase builds them from the same `scalars` object
// plus that one extra field.
function stubCaseEndpoints() {
	const createRequests: Record<string, unknown>[] = [];
	const updateRequests: Record<string, unknown>[] = [];

	mockMutation.mockImplementation(async (_ref: unknown, args: Record<string, unknown>) => {
		if ("caseId" in args) {
			updateRequests.push(args);
			return { caseId: args.caseId };
		}
		createRequests.push(args);
		return { caseId: "convex-case-id" };
	});

	return { createRequests, updateRequests };
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
		const { createRequests } = stubCaseEndpoints();

		await submitCase(baseInput());

		expect(createRequests).toHaveLength(1);
		expect(mockMutation).toHaveBeenCalledTimes(1);
	});

	it("updates a case via the Convex updateCase mutation, passing its caseId", async () => {
		const { updateRequests } = stubCaseEndpoints();

		await submitCase(baseInput({ isEditMode: true, editCaseId: "42" }));

		expect(updateRequests).toHaveLength(1);
		expect(updateRequests[0]?.caseId).toBe("42");
		expect(mockMutation).toHaveBeenCalledTimes(1);
	});
});

describe("submitCase — upload prefix", () => {
	it("derives the prefix from the slugified case name", async () => {
		const { presignRequests } = stubUploadPipeline();
		stubCaseEndpoints();
		const persona = makePersona({
			profile_photo: new File(["x"], "photo.png", { type: "image/png" }),
		});

		await submitCase(
			baseInput({ caseName: "Sterling Industries!!", personas: [persona] }),
		);

		expect(presignRequests).toHaveLength(1);
		expect(presignRequests[0]?.prefix).toBe("cases/sterling-industries");
	});

	it("falls back to the bare 'cases' prefix when the case name slugifies to empty", async () => {
		const { presignRequests } = stubUploadPipeline();
		stubCaseEndpoints();
		const persona = makePersona({
			profile_photo: new File(["x"], "photo.png", { type: "image/png" }),
		});

		await submitCase(baseInput({ caseName: "!!!", personas: [persona] }));

		expect(presignRequests).toHaveLength(1);
		expect(presignRequests[0]?.prefix).toBe("cases");
	});
});

describe("submitCase — profile photo upload", () => {
	it("uploads a File-valued profile photo and replaces it with the returned FileRef", async () => {
		const { presignRequests } = stubUploadPipeline();
		const { createRequests } = stubCaseEndpoints();
		const persona = makePersona({
			id: "p1",
			profile_photo: new File(["binary"], "mary.png", { type: "image/png" }),
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(presignRequests).toHaveLength(1);
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.profile_photo).toEqual({
			object_key: "objects/1-mary.png",
			file_name: "mary.png",
			content_type: "image/png",
		});
	});

	it("passes an existing FileRef profile photo through without uploading it again", async () => {
		stubUploadPipeline();
		const { createRequests } = stubCaseEndpoints();
		const existingPhoto: FileRefPayload = {
			object_key: "cases/x/old.png",
			file_name: "old.png",
			content_type: "image/png",
		};
		const persona = makePersona({ profile_photo: existingPhoto });

		await submitCase(baseInput({ personas: [persona] }));

		// The whole point: an already-uploaded photo must not hit presign again.
		expect(mockAction).not.toHaveBeenCalled();
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.profile_photo).toEqual(existingPhoto);
	});
});

describe("submitCase — file attachments", () => {
	it("uploads a File-valued attachment, replacing it with a FileRef while keeping its other fields", async () => {
		const { presignRequests } = stubUploadPipeline();
		const { createRequests } = stubCaseEndpoints();
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

		expect(presignRequests).toHaveLength(1);
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		const sentFile = personas[0]?.files?.[0];
		expect(sentFile?.file).toEqual({
			object_key: "objects/1-budget.pdf",
			file_name: "budget.pdf",
			content_type: "application/pdf",
		});
		expect(sentFile?.share_conditions).toBe("always");
		expect(sentFile?.perceived_contents).toBe("budget");
	});

	it("preserves a file:null attachment entry as-is, uploading nothing for it", async () => {
		stubUploadPipeline();
		const { createRequests } = stubCaseEndpoints();
		const persona = makePersona({
			files: [
				{ file: null, share_conditions: "never", perceived_contents: "" },
			],
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(mockAction).not.toHaveBeenCalled();
		expect(createRequests).toHaveLength(1);
		const personas = createRequests[0]?.personas as PersonaPayload[];
		expect(personas[0]?.files?.[0]?.file).toBeNull();
	});
});

describe("submitCase — content type handling", () => {
	it("sends no contentType on presign and application/octet-stream on the PUT for a file with no MIME type", async () => {
		const { presignRequests, putRequests } = stubUploadPipeline();
		stubCaseEndpoints();
		// No `type` option — a real drag-and-dropped file of an unrecognized kind
		// behaves exactly like this (file.type === "").
		const persona = makePersona({
			profile_photo: new File(["data"], "note"),
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(presignRequests).toHaveLength(1);
		expect(putRequests).toHaveLength(1);
		expect(presignRequests[0]?.contentType).toBeUndefined();
		expect(putRequests[0]?.contentType).toBe("application/octet-stream");
	});
});

describe("submitCase — multiple personas and attachments", () => {
	it("uploads every File across personas/attachments and associates each returned key with the right entry", async () => {
		const { presignRequests, presignBatchCalls } = stubUploadPipeline();
		const { createRequests } = stubCaseEndpoints();
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
		// batched presign call, not 4 separate round trips. Runs through
		// Promise.all in uploadAll, so the count alone would not catch a
		// mis-association — the per-persona checks below do.
		expect(presignBatchCalls).toHaveLength(1);
		expect(presignRequests).toHaveLength(4);
		expect(createRequests).toHaveLength(1);
		const sentPersonas = (createRequests[0]?.personas ?? []) as PersonaPayload[];
		const sentP1 = sentPersonas.find((p) => p.id === "p1");
		const sentP2 = sentPersonas.find((p) => p.id === "p2");

		expect(sentP1?.profile_photo?.file_name).toBe("p1-photo.png");
		expect((sentP1?.files ?? []).map((f) => f.file?.file_name).sort()).toEqual([
			"p1-file1.pdf",
			"p1-file2.pdf",
		]);
		expect(sentP2?.files?.[0]?.file?.file_name).toBe("p2-file1.pdf");

		// Every object key is unique — a mis-mapped key would silently overwrite
		// one persona's file with another's, so uniqueness alone is a real check.
		const allKeys = [
			sentP1?.profile_photo?.object_key,
			...(sentP1?.files ?? []).map((f) => f.file?.object_key),
			...(sentP2?.files ?? []).map((f) => f.file?.object_key),
		];
		expect(new Set(allKeys).size).toBe(allKeys.length);
	});
});

describe("submitCase — upload failures", () => {
	it("rejects with 'Failed to upload file to Spaces.' and never creates the case when the Spaces PUT fails", async () => {
		stubUploadPipeline({ putStatus: 500 });
		stubCaseEndpoints();
		const persona = makePersona({
			profile_photo: new File(["a"], "photo.png", { type: "image/png" }),
		});

		await expect(
			submitCase(baseInput({ personas: [persona] })),
		).rejects.toThrow("Failed to upload file to Spaces.");
		expect(mockMutation).not.toHaveBeenCalled();
	});

	it("propagates a failed presign action call, never creating the case", async () => {
		mockAction.mockRejectedValue(new Error("Presign failed."));
		stubCaseEndpoints();
		const persona = makePersona({
			profile_photo: new File(["a"], "photo.png", { type: "image/png" }),
		});

		const err = await submitCase(baseInput({ personas: [persona] })).catch(
			(e) => e,
		);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("Presign failed.");
		expect(mockMutation).not.toHaveBeenCalled();
	});
});

describe("submitCase — payload shaping", () => {
	it("trims top-level text fields, reduces referrals to their wire shape, and passes roots/collaborator ids through unchanged", async () => {
		const { createRequests } = stubCaseEndpoints();

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
