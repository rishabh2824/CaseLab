import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { CaseStructure } from "../models/cases";
import {
	driveTurn,
	makeLlmFetch,
	newTestConvex,
	withAdmin,
	withGoogleIdentity,
} from "../test.setup";
import {
	caseStructure,
	fileEntry,
	personaPayload,
	referralEdge,
	uniqueAccessCode,
} from "../testFactories";
import { type CasePayload, createCase, validateGraph } from "./cases";
import {
	exportSimulation,
	getPersonaHistory,
	getSimulationState,
	startSimulation,
} from "./simulations";
import { startTurn } from "./turn";

type T = ReturnType<typeof newTestConvex>;

beforeEach(() => {
	vi.stubEnv("LLM_KEY", "test-key");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

// Stubs the global fetch with the fake LLM and returns its recorded calls.
function stub(options: Parameters<typeof makeLlmFetch>[0] = {}) {
	const { calls, fetch } = makeLlmFetch(options);
	vi.stubGlobal("fetch", vi.fn(fetch));
	return calls;
}

// Inserts an admin with the given role and returns the document.
async function makeAdmin(
	t: T,
	role: "super" | "admin" = "admin",
): Promise<Doc<"admins">> {
	const id = await t.run((ctx) =>
		ctx.db.insert("admins", {
			email: `${role}-${Math.random().toString(36).slice(2)}@test.caselab.invalid`,
			role,
		}),
	);
	return (await t.run((ctx) => ctx.db.get(id)))!;
}

// Builds a valid case payload with a unique access code and optional overrides.
function payload(overrides: Partial<CasePayload> = {}): CasePayload {
	return {
		name: "Sterling Industries",
		brief: "Reduce office supply costs.",
		accessCode: uniqueAccessCode(),
		personas: [personaPayload("A")],
		referrals: [],
		roots: ["A"],
		collaboratorAdminIds: [],
		...overrides,
	};
}

// Seeds a case with the given structure and access code and starts a run on it.
async function startRunWithStructure(
	t: T,
	structure: CaseStructure,
	accessCode = "sterling",
) {
	const adminId = await t.run((ctx) =>
		ctx.db.insert("admins", {
			email: `o-${Math.random().toString(36).slice(2)}@test.caselab.invalid`,
			role: "admin",
		}),
	);
	await t.run((ctx) =>
		ctx.db.insert("cases", {
			name: "Case",
			brief: "Brief",
			accessCode,
			ownerAdminId: adminId,
			structure,
		}),
	);
	return await t.run((ctx) => startSimulation(ctx, accessCode));
}

// Starts a turn and drives its reply stream to completion.
async function send(
	t: T,
	runId: Id<"runs">,
	personaId: string,
	message: string,
) {
	await t.run((ctx) => startTurn(ctx, runId, personaId, message));
	await driveTurn(t, runId, personaId);
}

describe("a persona that is both a root and a referral target", () => {
	async function unlockRootViaReferral(t: T) {
		const state = await startRunWithStructure(
			t,
			caseStructure({
				personas: [personaPayload("A"), personaPayload("B")],
				referrals: [
					referralEdge("A", "B", "the user asks who else is involved"),
				],
				roots: ["A", "B"],
			}),
		);
		stub({ replyText: "You should talk to B.", introduce: ["R1"] });
		await send(t, state.run_id, "A", "who else is involved?");
		return state;
	}

	// Tests that a persona that is both a root and a referral target appears exactly once in the contact list.
	it("REGRESSION: appears exactly once in the contact list", async () => {
		const t = newTestConvex();
		const state = await unlockRootViaReferral(t);

		const live = await t.run((ctx) => getSimulationState(ctx, state.run_id));
		expect(live.contacts.map((c) => c.id)).toEqual(["A", "B"]);
	});

	// Tests that a persona that is both a root and a referral target appears exactly once in the export.
	it("REGRESSION: appears exactly once in the export, with one copy of its transcript", async () => {
		const t = newTestConvex();
		const state = await unlockRootViaReferral(t);
		stub({ replyText: "Hello from B." });
		await send(t, state.run_id, "B", "hi B");

		const exported = await t.run((ctx) => exportSimulation(ctx, state.run_id));
		expect(exported.personas.map((p) => p.id)).toEqual(["A", "B"]);
		expect(exported.personas.find((p) => p.id === "B")?.messages).toHaveLength(
			2,
		);
	});

	// Tests that a root id already recorded in unlockedReferredIds is deduped.
	it("dedupes a root id that is already recorded in a run's unlockedReferredIds", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(
			t,
			caseStructure({
				personas: [personaPayload("A"), personaPayload("B")],
				referrals: [
					referralEdge("A", "B", "the user asks who else is involved"),
				],
				roots: ["A", "B"],
			}),
		);
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, {
				unlockedReferredIds: ["B", "B"],
				unlockedAt: { B: 3 },
			}),
		);

		const live = await t.run((ctx) => getSimulationState(ctx, state.run_id));
		expect(live.contacts.map((c) => c.id)).toEqual(["A", "B"]);

		const exported = await t.run((ctx) => exportSimulation(ctx, state.run_id));
		expect(exported.personas.map((p) => p.id)).toEqual(["A", "B"]);
	});

	// Tests that a repeated non-root id in unlockedReferredIds is deduped.
	it("dedupes a repeated non-root id in unlockedReferredIds", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(
			t,
			caseStructure({
				personas: [personaPayload("A"), personaPayload("B")],
				referrals: [referralEdge("A", "B", "the user asks for B")],
				roots: ["A"],
			}),
		);
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, {
				unlockedReferredIds: ["B", "B", "B"],
				unlockedAt: { B: 2 },
			}),
		);

		const live = await t.run((ctx) => getSimulationState(ctx, state.run_id));
		expect(live.contacts.map((c) => c.id)).toEqual(["A", "B"]);
	});

	// Tests that a persona that is already a root is never offered as a referral candidate.
	it("is never offered as a referral candidate in the first place", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(
			t,
			caseStructure({
				personas: [personaPayload("A"), personaPayload("B")],
				referrals: [
					referralEdge("A", "B", "the user asks who else is involved"),
				],
				roots: ["A", "B"],
			}),
		);
		const calls = stub({ replyText: "hi" });
		await send(t, state.run_id, "A", "who else?");

		const prompt = calls.find((c) => c.kind === "reply")!.body.messages[0]
			.content;
		expect(prompt).toContain("You have no one to introduce this turn.");
	});
});

describe("file references that don't resolve to a real files row", () => {
	// Tests that a file whose storage id has no files row is not offered.
	it("does not offer a file whose storage id has no files row", async () => {
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["orphan"])),
		);
		const state = await startRunWithStructure(
			t,
			caseStructure({
				personas: [
					personaPayload("A", {
						files: [
							fileEntry({
								storage_id: storageId,
								file_name: "orphan.pdf",
								share_conditions: "the user asks for it",
							}),
						],
					}),
				],
			}),
		);
		const calls = stub({ replyText: "hi" });

		await send(t, state.run_id, "A", "anything to share?");

		const prompt = calls.find((c) => c.kind === "reply")!.body.messages[0]
			.content;
		expect(prompt).toContain("You have no file to send this turn.");
		expect(prompt).not.toContain("orphan.pdf");
	});

	// Tests that a file whose storage id resolves to a files row is still shared.
	it("still shares a file whose storage id does resolve to a files row", async () => {
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["budget"])),
		);
		const fileId = await t.run((ctx) =>
			ctx.db.insert("files", { storageId, name: "budget.pdf" }),
		);
		const state = await startRunWithStructure(
			t,
			caseStructure({
				personas: [
					personaPayload("A", {
						files: [
							fileEntry({
								storage_id: storageId,
								share_conditions: "the user asks about the budget",
							}),
						],
					}),
				],
			}),
		);
		stub({ replyText: "Here.", sendFiles: ["F1"] });

		await send(t, state.run_id, "A", "budget?");

		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.sharedFiles).toEqual([fileId]);
	});
});

describe("persona ids as Convex record keys", () => {
	const illegal = ["$boss", "café", "persona id", "emoji-🙂"];

	// Tests that persona ids unsafe as Convex record keys are rejected at case-save time.
	it.each(illegal)(
		"rejects %s as a persona id at case-save time",
		async (badId) => {
			expect(() => validateGraph([personaPayload(badId)], [], [badId])).toThrow(
				/persona id/i,
			);
		},
	);

	// Tests that the id shapes produced by the authoring UI and old data are still accepted.
	it("still accepts the id shapes the authoring UI and old data actually produce", () => {
		const ok = [
			"550e8400-e29b-41d4-a716-446655440000",
			"1",
			"persona_A",
			"persona.A",
			"A-B",
		];
		expect(() =>
			validateGraph(
				ok.map((id) => personaPayload(id)),
				[],
				ok,
			),
		).not.toThrow();
	});

	// Tests that a bad persona id is rejected through the public create mutation, not just the helper.
	it("rejects the bad id through the public create mutation, not just the pure helper", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		await expect(
			asUser.mutation(api.api.cases.create, {
				name: "C",
				brief: "B",
				accessCode: uniqueAccessCode(),
				personas: [personaPayload("$boss")],
				referrals: [],
				roots: ["$boss"],
				collaboratorAdminIds: [],
			}),
		).rejects.toThrow(/persona id/i);
	});

	// Tests that re-saving a legacy case with an illegal persona id is refused.
	it("refuses to re-save a legacy case carrying an illegal persona id", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) =>
				createCase(
					ctx,
					payload({ personas: [personaPayload("café")], roots: ["café"] }),
					admin,
				),
			),
		).rejects.toThrow(/persona id/i);
	});
});

describe("simulation duration", () => {
	const rejected: [label: string, duration: number][] = [
		["negative", -5],
		["zero", 0],
		["fractional", 0.5],
		["longer than a run can possibly live", 99_999],
		["absurd", Number.MAX_SAFE_INTEGER],
	];

	// Tests that invalid simulation durations are rejected at save time.
	it.each(rejected)(
		"REGRESSION: rejects a %s duration at save time",
		async (_label, duration) => {
			const t = newTestConvex();
			const admin = await makeAdmin(t);
			await expect(
				t.run((ctx) => createCase(ctx, payload({ duration }), admin)),
			).rejects.toThrow(/duration/i);
		},
	);

	// Tests that the boundary durations the authoring UI allows are accepted.
	it("accepts the boundary values the authoring UI allows", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		for (const duration of [1, 60, 120]) {
			await expect(
				t.run((ctx) => createCase(ctx, payload({ duration }), admin)),
			).resolves.toBeDefined();
		}
	});

	// Tests that a case with no duration (an untimed run) is still accepted.
	it("still accepts a case with no duration at all (an untimed run)", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload(), admin)),
		).resolves.toBeDefined();
	});

	// Tests that a saved duration stays within the lifetime a run can actually reach.
	it("keeps a saved duration within the lifetime a run can actually reach", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(ctx, payload({ duration: 120, accessCode: "capped" }), admin),
		);
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		const state = await t.run((ctx) => startSimulation(ctx, "capped"));
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;

		const lifetimeMinutes = (run.expiresAt - run.startTime) / 60_000;
		expect(c.duration!).toBeLessThanOrEqual(lifetimeMinutes);
	});
});

describe("student message boundaries", () => {
	// Tests that unicode, emoji, newlines and punctuation in a message are accepted unchanged.
	it("accepts unicode, emoji, newlines and punctuation without mangling them", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(t, caseStructure());
		stub({ replyText: "ok" });
		const message = "Café ☕\nQ3 — 40 % ↑ 🙂 <script>alert(1)</script>";

		await send(t, state.run_id, "A", message);

		const history = await t.run((ctx) =>
			getPersonaHistory(ctx, state.run_id, "A"),
		);
		expect(history[0]).toEqual({ role: "user", content: message });
	});

	// Tests that words are counted across every kind of whitespace, not just spaces.
	it("counts words across every kind of whitespace, not just spaces", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(t, caseStructure());
		stub({ replyText: "ok" });
		const tooLong = Array.from({ length: 51 }, (_, i) => `w${i}`).join("\n\t ");

		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", tooLong)),
		).rejects.toThrow(/too long/);
	});

	// Tests that a message of exactly the word limit is accepted and one more word is rejected.
	it("accepts exactly the word limit and rejects one more", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(t, caseStructure());
		stub({ replyText: "ok" });

		await expect(
			t.run((ctx) =>
				startTurn(ctx, state.run_id, "A", Array(50).fill("word").join(" ")),
			),
		).resolves.toBeNull();
		await driveTurn(t, state.run_id, "A");
		await expect(
			t.run((ctx) =>
				startTurn(ctx, state.run_id, "A", Array(51).fill("word").join(" ")),
			),
		).rejects.toThrow(/too long/);
	});

	// Tests that a 50-word message of enormous words fails loudly while leaving the run usable.
	it("fails loudly, and leaves the run usable, for a 50-word message of enormous words", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(t, caseStructure());
		stub({ replyText: "ok" });
		const huge = Array(50).fill("x".repeat(50_000)).join(" ");

		await t
			.run((ctx) => startTurn(ctx, state.run_id, "A", huge))
			.catch(() => {});
		await driveTurn(t, state.run_id, "A").catch(() => {});

		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", "a normal question")),
		).resolves.toBeNull();
	});
});

describe("access codes", () => {
	// Tests that a student's access code matches regardless of casing and surrounding whitespace.
	it("matches a student's code regardless of casing and surrounding whitespace", async () => {
		const t = newTestConvex();
		await startRunWithStructure(t, caseStructure(), "sterling");
		await expect(
			t.run((ctx) => startSimulation(ctx, "  StErLiNg\t")),
		).resolves.toMatchObject({ case: { case_name: "Case" } });
	});

	// Tests that access codes with digits, uppercase, hyphens, spaces, unicode or emoji are rejected at save time.
	it.each([
		["digits", "case1"],
		["uppercase", "Sterling"],
		["a hyphen", "case-one"],
		["a space", "two words"],
		["unicode", "café"],
		["an emoji", "🙂"],
	])(
		"rejects an access code containing %s at save time",
		async (_label, code) => {
			const t = newTestConvex();
			const admin = await makeAdmin(t);
			await expect(
				t.run((ctx) => createCase(ctx, payload({ accessCode: code }), admin)),
			).rejects.toThrow(/lowercase letters/);
		},
	);

	// Tests that a blank or whitespace-only access code is rejected at save time.
	it("rejects a blank or whitespace-only access code -- every case needs a real one", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ accessCode: "   " }), admin)),
		).rejects.toThrow("Access code is required.");
		await expect(
			t.run((ctx) => createCase(ctx, payload({ accessCode: "" }), admin)),
		).rejects.toThrow("Access code is required.");
	});

	// Tests that a run never starts from a blank code even if a case somehow stored one.
	it("never starts a run from a blank code even if a case somehow stored one", async () => {
		const t = newTestConvex();
		await expect(t.run((ctx) => startSimulation(ctx, ""))).rejects.toThrow(
			"Access code is required.",
		);
		await expect(t.run((ctx) => startSimulation(ctx, "   "))).rejects.toThrow(
			"Access code is required.",
		);
	});
});

describe("admin email identity", () => {
	// Tests that an admin invited with a mixed-case email can still sign in.
	it("REGRESSION: an admin invited with mixed-case email can still sign in", async () => {
		const t = newTestConvex();
		const superAdmin = await withAdmin(t, {
			email: "super@test.caselab.invalid",
			role: "super",
		});
		await superAdmin.asUser.mutation(api.api.admins.create, {
			email: "Jane.Doe@Wisc.Edu",
			role: "admin",
		});

		const asJane = await withGoogleIdentity(t, "jane.doe@wisc.edu");
		await expect(
			asJane.query(api.api.admins.viewer, {}),
		).resolves.toMatchObject({ role: "admin" });
	});

	// Tests that a duplicate admin email differing only in casing or padding is rejected.
	it("REGRESSION: rejects a duplicate that differs only in casing or padding", async () => {
		const t = newTestConvex();
		const superAdmin = await withAdmin(t, {
			email: "super2@test.caselab.invalid",
			role: "super",
		});
		await superAdmin.asUser.mutation(api.api.admins.create, {
			email: "jane@wisc.edu",
			role: "admin",
		});
		await expect(
			superAdmin.asUser.mutation(api.api.admins.create, {
				email: "  JANE@WISC.EDU ",
				role: "admin",
			}),
		).rejects.toThrow("An admin with this email already exists.");
	});

	// Tests that an admin is resolved when the signed-in email differs only in casing.
	it("resolves an admin when the signed-in identity's email differs only in casing", async () => {
		const t = newTestConvex();
		await t.run((ctx) =>
			ctx.db.insert("admins", { email: "jane@wisc.edu", role: "admin" }),
		);
		const asJane = await withGoogleIdentity(t, "Jane@Wisc.Edu");

		await expect(
			asJane.query(api.api.admins.viewer, {}),
		).resolves.toMatchObject({ email: "jane@wisc.edu", role: "admin" });
		await expect(asJane.query(api.api.cases.listAll, {})).resolves.toEqual([]);
	});

	// Tests that a blank admin email is rejected instead of creating an unusable roster row.
	it("rejects a blank email outright rather than creating an unusable roster row", async () => {
		const t = newTestConvex();
		const superAdmin = await withAdmin(t, {
			email: "super3@test.caselab.invalid",
			role: "super",
		});
		await expect(
			superAdmin.asUser.mutation(api.api.admins.create, {
				email: "   ",
				role: "admin",
			}),
		).rejects.toThrow(/email/i);
	});
});

describe("persona graph structure", () => {
	// Tests that a 5000-deep referral chain validates without overflowing the stack.
	it("validates a 5000-deep referral chain without overflowing the stack", () => {
		const personas = Array.from({ length: 5000 }, (_, i) =>
			personaPayload(`p${i}`),
		);
		const referrals = Array.from({ length: 4999 }, (_, i) =>
			referralEdge(`p${i}`, `p${i + 1}`, "next"),
		);
		expect(() => validateGraph(personas, referrals, ["p0"])).not.toThrow();
	});

	// Tests that a cycle at the end of a long chain is still detected.
	it("still detects a cycle buried at the end of a long chain", () => {
		const personas = Array.from({ length: 500 }, (_, i) =>
			personaPayload(`p${i}`),
		);
		const referrals = [
			...Array.from({ length: 499 }, (_, i) =>
				referralEdge(`p${i}`, `p${i + 1}`, "next"),
			),
			referralEdge("p499", "p250", "back"),
		];
		expect(() => validateGraph(personas, referrals, ["p0"])).toThrow(/cycle/i);
	});

	// Tests that a self-referral is rejected as a one-node cycle.
	it("rejects a self-referral, which is a one-node cycle", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A")],
				[referralEdge("A", "A", "loop")],
				["A"],
			),
		).toThrow(/cycle/i);
	});

	// Tests that a case with no root personas is rejected at save time.
	it("REGRESSION: rejects a case with no root personas at save time", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ roots: [] }), admin)),
		).rejects.toThrow(/root/i);
	});

	// Tests that an empty persona list is rejected at save time.
	it("rejects an empty persona list, which can only ever produce an unusable case", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) =>
				createCase(ctx, payload({ personas: [], roots: [] }), admin),
			),
		).rejects.toThrow();
	});
});
