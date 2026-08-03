// Node project: submitCase orchestrates the two-phase direct-to-Spaces upload
// (presign, then PUT straight to the returned URL) and builds the case
// create/update payload. Nothing else exercises it, and a silent
// field-mapping bug here (e.g. an uploaded key landing on the wrong persona)
// would corrupt a saved case without ever throwing.
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { makePersona } from "../../testing/fixtures.js";
import { server } from "../../testing/msw.js";
import { ApiError } from "../api/client.js";
import type { Api } from "../types.js";
import { type SubmitCaseInput, submitCase } from "./submitCase.js";

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

type PresignCapture = {
	file_name: string;
	content_type: string | null;
	prefix: string | null;
};

// Wires a working presign endpoint (each call gets a unique object_key so a
// test can verify which upload produced which key) and the Spaces PUT it
// hands back. `putStatus` lets the Spaces-failure test reuse this without
// hand-rolling its own handlers.
function stubUploadPipeline({ putStatus = 200 }: { putStatus?: number } = {}) {
	const presignRequests: PresignCapture[] = [];
	const putRequests: { url: string; contentType: string | null }[] = [];
	let counter = 0;

	server.use(
		http.post("*/api/uploads/presign", async ({ request }) => {
			const body = (await request.json()) as PresignCapture;
			presignRequests.push(body);
			counter += 1;
			const objectKey = `objects/${counter}-${body.file_name}`;
			return HttpResponse.json({
				upload_url: `${SPACES_ORIGIN}/${objectKey}`,
				object_key: objectKey,
				file_name: body.file_name,
				content_type: body.content_type,
				expires_in: 900,
			} satisfies Api<"PresignUploadResponse">);
		}),
		http.put(`${SPACES_ORIGIN}/*`, ({ request }) => {
			putRequests.push({
				url: request.url,
				contentType: request.headers.get("content-type"),
			});
			return new HttpResponse(null, { status: putStatus });
		}),
	);

	return { presignRequests, putRequests };
}

// Wires /api/cases (create) and /api/cases/:id (update) and captures every
// request body MSW actually received — the payload-shaping assertions below
// read these rather than re-deriving what submitCase "should" have sent.
function stubCaseEndpoints() {
	const createRequests: Api<"CasePayload">[] = [];
	const updateRequests: { id: string; body: Api<"CaseUpdatePayload"> }[] = [];

	server.use(
		http.post("*/api/cases", async ({ request }) => {
			createRequests.push((await request.json()) as Api<"CasePayload">);
			return HttpResponse.json({
				case_id: 1,
			} satisfies Api<"CaseCreatedResponse">);
		}),
		http.put("*/api/cases/:id", async ({ request, params }) => {
			updateRequests.push({
				id: params.id as string,
				body: (await request.json()) as Api<"CaseUpdatePayload">,
			});
			return HttpResponse.json({
				case_id: Number(params.id),
			} satisfies Api<"CaseCreatedResponse">);
		}),
	);

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
		accessCode: "ABC123",
		personas: [],
		referrals: [],
		roots: [],
		collaboratorAdminIds: [],
		...overrides,
	};
}

describe("submitCase — create vs. edit routing", () => {
	it("creates a case with POST /api/cases and no expected_version field at all", async () => {
		const { createRequests } = stubCaseEndpoints();

		await submitCase(baseInput());

		expect(createRequests).toHaveLength(1);
		expect(createRequests[0]).not.toHaveProperty("expected_version");
	});

	it("updates a case with PUT /api/cases/{id}, including expected_version", async () => {
		const { updateRequests } = stubCaseEndpoints();

		await submitCase(
			baseInput({ isEditMode: true, editCaseId: "42", expectedVersion: 7 }),
		);

		expect(updateRequests).toHaveLength(1);
		expect(updateRequests[0]?.id).toBe("42");
		expect(updateRequests[0]?.body.expected_version).toBe(7);
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
		const sentPersona = createRequests[0]?.personas?.[0];
		expect(sentPersona?.profile_photo).toEqual({
			object_key: "objects/1-mary.png",
			file_name: "mary.png",
			content_type: "image/png",
		});
	});

	it("passes an existing FileRef profile photo through without uploading it again", async () => {
		const { presignRequests } = stubUploadPipeline();
		const { createRequests } = stubCaseEndpoints();
		const existingPhoto: Api<"FileRef"> = {
			object_key: "cases/x/old.png",
			file_name: "old.png",
			content_type: "image/png",
		};
		const persona = makePersona({ profile_photo: existingPhoto });

		await submitCase(baseInput({ personas: [persona] }));

		// The whole point: an already-uploaded photo must not hit presign again.
		expect(presignRequests).toHaveLength(0);
		expect(createRequests).toHaveLength(1);
		expect(createRequests[0]?.personas?.[0]?.profile_photo).toEqual(
			existingPhoto,
		);
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
		const sentFile = createRequests[0]?.personas?.[0]?.files?.[0];
		expect(sentFile?.file).toEqual({
			object_key: "objects/1-budget.pdf",
			file_name: "budget.pdf",
			content_type: "application/pdf",
		});
		expect(sentFile?.share_conditions).toBe("always");
		expect(sentFile?.perceived_contents).toBe("budget");
	});

	it("preserves a file:null attachment entry as-is, uploading nothing for it", async () => {
		const { presignRequests } = stubUploadPipeline();
		const { createRequests } = stubCaseEndpoints();
		const persona = makePersona({
			files: [
				{ file: null, share_conditions: "never", perceived_contents: "" },
			],
		});

		await submitCase(baseInput({ personas: [persona] }));

		expect(presignRequests).toHaveLength(0);
		expect(createRequests).toHaveLength(1);
		expect(createRequests[0]?.personas?.[0]?.files?.[0]?.file).toBeNull();
	});
});

describe("submitCase — content type handling", () => {
	it("sends content_type: null on presign and application/octet-stream on the PUT for a file with no MIME type", async () => {
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
		expect(presignRequests[0]?.content_type).toBeNull();
		expect(putRequests[0]?.contentType).toBe("application/octet-stream");
	});
});

describe("submitCase — multiple personas and attachments", () => {
	it("uploads every File across personas/attachments and associates each returned key with the right entry", async () => {
		const { presignRequests } = stubUploadPipeline();
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

		// 4 uploads total: p1's photo + 2 files, p2's 1 file. Runs through
		// Promise.all in buildPersonaPayload, so the count alone would not
		// catch a mis-association — the per-persona checks below do.
		expect(presignRequests).toHaveLength(4);
		expect(createRequests).toHaveLength(1);
		const sentPersonas = createRequests[0]?.personas ?? [];
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
		let caseRequestSeen = false;
		server.use(
			http.post("*/api/cases", () => {
				caseRequestSeen = true;
				return HttpResponse.json({ case_id: 1 });
			}),
		);
		const persona = makePersona({
			profile_photo: new File(["a"], "photo.png", { type: "image/png" }),
		});

		await expect(
			submitCase(baseInput({ personas: [persona] })),
		).rejects.toThrow("Failed to upload file to Spaces.");
		expect(caseRequestSeen).toBe(false);
	});

	it("propagates a failed presign request as an ApiError", async () => {
		server.use(
			http.post("*/api/uploads/presign", () =>
				HttpResponse.json({ detail: "Presign failed." }, { status: 500 }),
			),
		);
		const persona = makePersona({
			profile_photo: new File(["a"], "photo.png", { type: "image/png" }),
		});

		const err = await submitCase(baseInput({ personas: [persona] })).catch(
			(e) => e,
		);

		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).message).toBe("Presign failed.");
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
				accessCode: "  ABC123  ",
				referrals: [
					{ from_id: "p1", to_id: "p2", conditions: "  when asked  " },
				],
				roots: ["p1"],
				collaboratorAdminIds: [2, 5],
			}),
		);

		expect(createRequests).toHaveLength(1);
		const [body] = createRequests;
		if (!body) throw new Error("expected a captured create request");
		expect(body.case_name).toBe("Sterling Industries");
		expect(body.initial_brief).toBe("Reduce office supply costs.");
		expect(body.common_information).toBe("Background context.");
		expect(body.access_code).toBe("ABC123");
		// Reduced to exactly {from_id, to_id, conditions} — conditions itself is
		// passed through untrimmed, only the top-level case fields are trimmed.
		expect(body.referrals).toEqual([
			{ from_id: "p1", to_id: "p2", conditions: "  when asked  " },
		]);
		expect(body.roots).toEqual(["p1"]);
		expect(body.collaborator_admin_ids).toEqual([2, 5]);
	});
});
