import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	caseStructure,
	fileEntry,
	personaPayload,
	referralEdge,
	uniqueAccessCode,
} from "../../tests/support/factories";
import { api } from "../_generated/api";
import { validateGraph } from "../lib/caseStructure";
import { MAX_MESSAGE_CHARS } from "../lib/constants";
import { STUDENT_ERROR } from "../lib/studentErrors";
import {
	casePayload,
	lastReply,
	makeAdmin,
	newTestConvex,
	sendTurn,
	startRun,
	stubLlm,
	studentRejection,
	withAdmin,
	withGoogleIdentity,
} from "../test.setup";
import { createCase } from "./cases";

type T = ReturnType<typeof newTestConvex>;

beforeEach(() => {
	vi.stubEnv("LLM_KEY", "test-key");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("a persona that is both a root and a referral target", () => {
	async function unlockRootViaReferral(t: T) {
		const state = await startRun(
			t,
			caseStructure({
				personas: [personaPayload("A"), personaPayload("B")],
				referrals: [
					referralEdge("A", "B", "the user asks who else is involved"),
				],
				roots: ["A", "B"],
			}),
		);
		stubLlm({ replyText: "You should talk to B.", introduce: ["R1"] });
		await sendTurn(t, state.runId, "A", "who else is involved?");
		return state;
	}

	// Tests that a persona that is both a root and a referral target appears exactly once in the contact list.
	it("REGRESSION: appears exactly once in the contact list", async () => {
		const t = newTestConvex();
		const state = await unlockRootViaReferral(t);

		const live = await t.query(api.simulations.get, { runId: state.runId });
		expect(live.contacts.map((c) => c.id)).toEqual(["A", "B"]);
	});

	// Tests that a persona that is both a root and a referral target appears exactly once in the export.
	it("REGRESSION: appears exactly once in the export, with one copy of its transcript", async () => {
		const t = newTestConvex();
		const state = await unlockRootViaReferral(t);
		stubLlm({ replyText: "Hello from B." });
		await sendTurn(t, state.runId, "B", "hi B");

		const exported = await t.query(api.simulations.exportRun, {
			runId: state.runId,
		});
		expect(exported.personas.map((p) => p.id)).toEqual(["A", "B"]);
		expect(exported.personas.find((p) => p.id === "B")?.messages).toHaveLength(
			2,
		);
	});

	// Tests that a root id already recorded in unlockedAt is not listed twice.
	it("lists a root id that is already recorded in a run's unlockedAt only once", async () => {
		const t = newTestConvex();
		const state = await startRun(
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
			ctx.db.patch(state.runId, {
				unlockedAt: { B: 3 },
			}),
		);

		const live = await t.query(api.simulations.get, { runId: state.runId });
		expect(live.contacts.map((c) => c.id)).toEqual(["A", "B"]);

		const exported = await t.query(api.simulations.exportRun, {
			runId: state.runId,
		});
		expect(exported.personas.map((p) => p.id)).toEqual(["A", "B"]);
	});

	// Tests that a persona that is already a root is never offered as a referral candidate.
	it("is never offered as a referral candidate in the first place", async () => {
		const t = newTestConvex();
		const state = await startRun(
			t,
			caseStructure({
				personas: [personaPayload("A"), personaPayload("B")],
				referrals: [
					referralEdge("A", "B", "the user asks who else is involved"),
				],
				roots: ["A", "B"],
			}),
		);
		const { calls } = stubLlm({ replyText: "hi" });
		await sendTurn(t, state.runId, "A", "who else?");

		const prompt = calls.find((c) => c.kind === "reply")!.body.messages[0]
			.content;
		expect(prompt).toContain("You have no one to introduce this turn.");
	});
});

describe("shared files resolve from storage", () => {
	// Tests that a file whose upload exists is shared, with its name from the case.
	it("shares a file whose upload exists, naming it from the case", async () => {
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["budget"])),
		);
		const state = await startRun(
			t,
			caseStructure({
				personas: [
					personaPayload("A", {
						files: [
							fileEntry({
								storageId: storageId,
								shareConditions: "the user asks about the budget",
							}),
						],
					}),
				],
			}),
		);
		stubLlm({ replyText: "Here.", sendFiles: ["F1"] });

		await sendTurn(t, state.runId, "A", "budget?");

		const run = (await t.run((ctx) => ctx.db.get(state.runId)))!;
		expect(run.sharedFiles).toEqual([storageId]);
		const live = await t.query(api.simulations.get, { runId: state.runId });
		expect(live.sharedFiles).toMatchObject([
			{ fileId: storageId, fileName: "doc.pdf" },
		]);
	});
});

describe("persona ids as Convex record keys", () => {
	// Tests that a bad persona id is rejected through the public create mutation, not just the helper.
	it("rejects the bad id through the public create mutation, not just the pure helper", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		await expect(
			asUser.mutation(api.cases.create, {
				name: "C",
				brief: "B",
				commonInformation: "",
				accessCode: uniqueAccessCode(),
				structure: {
					personas: [personaPayload("$boss")],
					referrals: [],
					roots: ["$boss"],
				},
				collaborators: [],
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
					casePayload({ personas: [personaPayload("café")], roots: ["café"] }),
					admin,
				),
			),
		).rejects.toThrow(/persona id/i);
	});
});

describe("simulation duration", () => {
	// Tests that an invalid simulation duration is rejected at save time; the rules themselves are tested in caseRules.test.
	it("REGRESSION: rejects an invalid duration at save time", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, casePayload({ duration: 0 }), admin)),
		).rejects.toThrow(/duration/i);
	});

	// Tests that a case with no duration (an untimed run) is still accepted.
	it("still accepts a case with no duration at all (an untimed run)", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, casePayload(), admin)),
		).resolves.toBeDefined();
	});

	// Tests that a saved duration stays within the lifetime a run can actually reach.
	it("keeps a saved duration within the lifetime a run can actually reach", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				casePayload({ duration: 120, accessCode: "capped" }),
				admin,
			),
		);
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		const state = await t.mutation(api.simulations.start, {
			accessCode: "capped",
		});
		const run = (await t.run((ctx) => ctx.db.get(state.runId)))!;

		const lifetimeMinutes = Math.round(
			(run.expiresAt - run._creationTime) / 60_000,
		);
		expect(c.duration!).toBeLessThanOrEqual(lifetimeMinutes);
	});
});

describe("student message boundaries", () => {
	// Tests that unicode, emoji, newlines and punctuation in a message are accepted unchanged.
	it("accepts unicode, emoji, newlines and punctuation without mangling them", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		stubLlm({ replyText: "ok" });
		const message = "Café ☕\nQ3 — 40 % ↑ 🙂 <script>alert(1)</script>";

		await sendTurn(t, state.runId, "A", message);

		const { messages } = await t.query(api.simulations.getPersonaHistory, {
			runId: state.runId,
			personaId: "A",
		});
		expect(messages[0]).toEqual({ role: "user", content: message });
	});

	// Tests that a message of exactly the word limit is accepted and one more word is rejected.
	it("accepts exactly the word limit and rejects one more", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		stubLlm({ replyText: "ok" });

		await sendTurn(t, state.runId, "A", Array(50).fill("word").join(" "));
		expect((await lastReply(t, state.runId, "A"))?.status).toBe("done");
		await expect(
			t.mutation(api.turn.sendMessage, {
				runId: state.runId,
				personaId: "A",
				message: Array(51).fill("word").join(" "),
			}),
		).rejects.toThrow(/too long/);
	});

	// Tests that a message of exactly the character limit is accepted and one more character is rejected.
	it("accepts exactly the character limit and rejects one more character", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		stubLlm({ replyText: "ok" });

		await sendTurn(t, state.runId, "A", "x".repeat(MAX_MESSAGE_CHARS));
		expect((await lastReply(t, state.runId, "A"))?.status).toBe("done");
		expect(
			await studentRejection(
				t.mutation(api.turn.sendMessage, {
					runId: state.runId,
					personaId: "A",
					message: "x".repeat(MAX_MESSAGE_CHARS + 1),
				}),
			),
		).toMatchObject({ code: STUDENT_ERROR.MESSAGE_TOO_LONG });
	});

	// Tests that a 50-word message of enormous words is rejected as too long while leaving the run usable.
	it("rejects a 50-word message of enormous words as too long, and leaves the run usable", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		stubLlm({ replyText: "ok" });
		const huge = Array(50).fill("x".repeat(50_000)).join(" ");

		const outcome = await studentRejection(
			t.mutation(api.turn.sendMessage, {
				runId: state.runId,
				personaId: "A",
				message: huge,
			}),
		);
		expect(outcome).toMatchObject({ code: STUDENT_ERROR.MESSAGE_TOO_LONG });
		expect(await lastReply(t, state.runId, "A")).toBeNull();

		await sendTurn(t, state.runId, "A", "a normal question");
		expect((await lastReply(t, state.runId, "A"))?.status).toBe("done");
	});
});

describe("access codes", () => {
	// Tests that a student's access code matches regardless of casing and surrounding whitespace.
	it("matches a student's code regardless of casing and surrounding whitespace", async () => {
		const t = newTestConvex();
		await startRun(t, caseStructure(), "sterling");
		await expect(
			t.mutation(api.simulations.start, { accessCode: "  StErLiNg\t" }),
		).resolves.toMatchObject({ runId: expect.any(String) });
	});

	// Tests that a run never starts from a blank code even if a case somehow stored one.
	it("never starts a run from a blank code even if a case somehow stored one", async () => {
		const t = newTestConvex();
		await expect(
			t.mutation(api.simulations.start, { accessCode: "" }),
		).rejects.toThrow("Access code is required.");
		await expect(
			t.mutation(api.simulations.start, { accessCode: "   " }),
		).rejects.toThrow("Access code is required.");
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
		await superAdmin.asUser.mutation(api.admins.create, {
			name: "Test Admin",
			email: "Jane.Doe@Wisc.Edu",
			role: "admin",
		});

		const asJane = await withGoogleIdentity(t, "jane.doe@wisc.edu");
		await expect(asJane.query(api.admins.viewer, {})).resolves.toMatchObject({
			role: "admin",
		});
	});

	// Tests that a duplicate admin email differing only in casing or padding is rejected.
	it("REGRESSION: rejects a duplicate that differs only in casing or padding", async () => {
		const t = newTestConvex();
		const superAdmin = await withAdmin(t, {
			email: "super2@test.caselab.invalid",
			role: "super",
		});
		await superAdmin.asUser.mutation(api.admins.create, {
			name: "Test Admin",
			email: "jane@wisc.edu",
			role: "admin",
		});
		await expect(
			superAdmin.asUser.mutation(api.admins.create, {
				name: "Test Admin",
				email: "  JANE@WISC.EDU ",
				role: "admin",
			}),
		).rejects.toThrow("An admin with this email already exists.");
	});

	// Tests that an admin is resolved when the signed-in email differs only in casing.
	it("resolves an admin when the signed-in identity's email differs only in casing", async () => {
		const t = newTestConvex();
		await t.run((ctx) =>
			ctx.db.insert("admins", {
				name: "Test Admin",
				email: "jane@wisc.edu",
				role: "admin",
			}),
		);
		const asJane = await withGoogleIdentity(t, "Jane@Wisc.Edu");

		await expect(asJane.query(api.admins.viewer, {})).resolves.toMatchObject({
			email: "jane@wisc.edu",
			role: "admin",
		});
		await expect(asJane.query(api.cases.listAll, {})).resolves.toEqual([]);
	});

	// Tests that a blank admin email is rejected instead of creating an unusable roster row.
	it("rejects a blank email outright rather than creating an unusable roster row", async () => {
		const t = newTestConvex();
		const superAdmin = await withAdmin(t, {
			email: "super3@test.caselab.invalid",
			role: "super",
		});
		await expect(
			superAdmin.asUser.mutation(api.admins.create, {
				name: "Test Admin",
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

	// Tests that a case with no root personas is rejected at save time.
	it("REGRESSION: rejects a case with no root personas at save time", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, casePayload({ roots: [] }), admin)),
		).rejects.toThrow(/root/i);
	});

	// Tests that an empty persona list is rejected at save time.
	it("rejects an empty persona list, which can only ever produce an unusable case", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) =>
				createCase(ctx, casePayload({ personas: [], roots: [] }), admin),
			),
		).rejects.toThrow();
	});
});
