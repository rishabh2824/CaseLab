// Data-integrity and hostile-input boundaries across the case -> run -> turn pipeline.
//
// The shared theme: `cases.structure`'s schema validator (caseStructureValidator, see
// models/cases.ts) constrains its shape, not its VALUES -- a referral can still point at a
// persona id nothing else references, an availability window can still be nonsensical, a
// file entry's storage id can still resolve to nothing. Those values all flow straight from
// an admin's browser (or from an imported HTML case file, which is genuinely untrusted input)
// into runtime code that indexes Convex records by them and hands them to `v.id()`-validated
// mutations. Every test here asks what a run does when one of those values is something the
// authoring UI would never produce -- structurally valid, semantically not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { CaseStructure } from "../models/cases";
import {
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

function stub(options: Parameters<typeof makeLlmFetch>[0] = {}) {
	const { calls, fetch } = makeLlmFetch(options);
	vi.stubGlobal("fetch", vi.fn(fetch));
	return calls;
}

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

function payload(overrides: Partial<CasePayload> = {}): CasePayload {
	return {
		name: "Sterling Industries",
		brief: "Reduce office supply costs.",
		personas: [personaPayload("A")],
		referrals: [],
		roots: ["A"],
		collaboratorAdminIds: [],
		...overrides,
	};
}

// Seeds a case by direct insert (bypassing createCase's validation) so a run can be started
// against a structure the authoring path would reject -- which is exactly the shape migrated
// data and imported case files can have.
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

async function send(
	t: T,
	runId: Id<"runs">,
	personaId: string,
	message: string,
) {
	await t.run((ctx) => startTurn(ctx, runId, personaId, message));
	await t.finishAllScheduledFunctions(() => {});
}

describe("a persona that is both a root and a referral target", () => {
	// simulationReads.test.ts already proves flattenPersonas stores such a persona once. Its
	// consumers don't: getSimulationState concatenates root personas with unlocked referred
	// personas, and exportSimulation concatenates graph.roots with unlockedReferredIds -- neither
	// dedupes, so the same persona surfaces twice the moment a referral to an existing root
	// fires. The student sees a duplicate contact card, and the exported PDF contains that
	// persona's entire transcript twice.
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

	it("REGRESSION: appears exactly once in the contact list", async () => {
		const t = newTestConvex();
		const state = await unlockRootViaReferral(t);

		const live = await t.run((ctx) => getSimulationState(ctx, state.run_id));
		expect(live.contacts.map((c) => c.id)).toEqual(["A", "B"]);
	});

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

	// The two tests above are satisfied by the SOURCE fix (getTurnContext never offers a root as
	// a referral candidate, so unlockedReferredIds can no longer acquire one). That leaves the
	// read-path dedupe -- which exists for runs whose state ALREADY contains such an id, saved
	// before that fix or by a direct write -- with nothing exercising it. Mutation-testing the
	// dedupe away left the suite green, so this seeds that legacy state directly.
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
		// The exact state a pre-fix run would be left in.
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

	// Same idea for a plain duplicate that isn't a root: an applyDecisions retry that recorded
	// the same referral twice must still render one contact.
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

	// The root fix: a root persona is reachable from minute 0, so offering a referral to it is a
	// no-op that only wastes prompt budget and invites the duplicate above.
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
	// The structure blob's file entries carry only a storage id -- getTurnContext resolves the
	// real `files` row by that storage id, not off any id embedded in the structure. The storage
	// object having no `files` row at all is pointless to offer as a candidate: nothing
	// downstream can ever record the share.
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

	// Positive control: a properly-resolved file still shares, so the guard above can't pass by
	// simply never sharing anything.
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
	// unlockedAt / personaChatState are v.record()s keyed by persona id. Convex
	// rejects a field name starting with "$" or containing non-ASCII, so such an id turns every
	// state-writing turn into a hard failure -- and persona ids are not generated server-side:
	// importCase.ts reads them straight out of an uploaded HTML file's data-persona-id
	// attributes. The authoring path is where this has to be caught, since by run time the only
	// options are "crash" and "silently drop the student's progress".
	const illegal = ["$boss", "café", "persona id", "emoji-🙂"];

	it.each(illegal)(
		"rejects %s as a persona id at case-save time",
		async (badId) => {
			expect(() => validateGraph([personaPayload(badId)], [], [badId])).toThrow(
				/persona id/i,
			);
		},
	);

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

	it("rejects the bad id through the public create mutation, not just the pure helper", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		await expect(
			asUser.mutation(api.api.cases.create, {
				name: "C",
				brief: "B",
				personas: [personaPayload("$boss")],
				referrals: [],
				roots: ["$boss"],
				collaboratorAdminIds: [],
			}),
		).rejects.toThrow(/persona id/i);
	});

	// Defense in depth: a case already in the database with such an id (saved before the
	// validation existed) must still fail loudly at save time rather than at turn time.
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
	// The 1..120 bound exists only in CaseForm.svelte. Nothing server-side enforces it, so a
	// direct API call (or a bypassed client) can persist a duration that makes the case
	// unusable or makes the student's own countdown lie to them.
	const rejected: [label: string, duration: number][] = [
		["negative", -5],
		["zero", 0],
		["fractional", 0.5],
		["longer than a run can possibly live", 99_999],
		["absurd", Number.MAX_SAFE_INTEGER],
	];

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

	it("accepts the boundary values the authoring UI allows", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		for (const duration of [1, 60, 120]) {
			await expect(
				t.run((ctx) => createCase(ctx, payload({ duration }), admin)),
			).resolves.toBeDefined();
		}
	});

	it("still accepts a case with no duration at all (an untimed run)", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload(), admin)),
		).resolves.toBeDefined();
	});

	// The reason the upper bound matters: a run's real lifetime is hard-capped at
	// RUN_LIFETIME_MINUTES, but the student's countdown is driven by the case's own duration. A
	// case saved with a longer duration produces a clock that never reaches zero while the run
	// is deleted out from under it.
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

	it("counts words across every kind of whitespace, not just spaces", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(t, caseStructure());
		stub({ replyText: "ok" });
		// 51 words separated by tabs/newlines -- a space-only split would see one word.
		const tooLong = Array.from({ length: 51 }, (_, i) => `w${i}`).join("\n\t ");

		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", tooLong)),
		).rejects.toThrow(/too long/);
	});

	it("accepts exactly the word limit and rejects one more", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(t, caseStructure());
		stub({ replyText: "ok" });

		await expect(
			t.run((ctx) =>
				startTurn(ctx, state.run_id, "A", Array(50).fill("word").join(" ")),
			),
		).resolves.toBeNull();
		await t.finishAllScheduledFunctions(() => {});
		await expect(
			t.run((ctx) =>
				startTurn(ctx, state.run_id, "A", Array(51).fill("word").join(" ")),
			),
		).rejects.toThrow(/too long/);
	});

	// The only length gate is a WORD count, so 50 "words" can still be megabytes. That reaches
	// a runMessages insert (Convex caps a document at 1 MiB) and the LLM prompt. Pinned as a
	// known limitation: the failure is at least loud and leaves the run usable.
	it("fails loudly, and leaves the run usable, for a 50-word message of enormous words", async () => {
		const t = newTestConvex();
		const state = await startRunWithStructure(t, caseStructure());
		stub({ replyText: "ok" });
		const huge = Array(50).fill("x".repeat(50_000)).join(" ");

		await t
			.run((ctx) => startTurn(ctx, state.run_id, "A", huge))
			.catch(() => {});
		await t.finishAllScheduledFunctions(() => {});

		// Whatever happened, a normal follow-up message still works.
		await expect(
			t.run((ctx) => startTurn(ctx, state.run_id, "A", "a normal question")),
		).resolves.toBeNull();
	});
});

describe("access codes", () => {
	it("matches a student's code regardless of casing and surrounding whitespace", async () => {
		const t = newTestConvex();
		await startRunWithStructure(t, caseStructure(), "sterling");
		await expect(
			t.run((ctx) => startSimulation(ctx, "  StErLiNg\t")),
		).resolves.toMatchObject({ case: { case_name: "Case" } });
	});

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

	it("treats a blank or whitespace-only access code as no code, not as an empty one", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(ctx, payload({ accessCode: "   " }), admin),
		);
		expect(
			(await t.run((ctx) => ctx.db.get(caseId)))!.accessCode,
		).toBeUndefined();

		// And two such cases don't collide with each other over an "empty" code.
		await expect(
			t.run((ctx) => createCase(ctx, payload({ accessCode: "" }), admin)),
		).resolves.toBeDefined();
	});

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
	// getAdminByEmail is an exact, case-sensitive index lookup, used both by the create-time
	// duplicate check and by auth.ts's sign-in gate. A super admin who types "Jane.Doe@wisc.edu"
	// creates a roster entry that Google's lower-cased profile email can never match -- the
	// invited admin is told "Your account is not authorized." with nothing in the UI to explain
	// why. The same gap lets two rows exist for the same human.
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

		// Google hands back the lower-cased address at sign-in.
		const asJane = await withGoogleIdentity(t, "jane.doe@wisc.edu");
		await expect(
			asJane.query(api.api.admins.viewer, {}),
		).resolves.toMatchObject({ role: "admin" });
	});

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

	// The write side normalizes too, so a test that only goes create -> sign-in never exercises
	// normalization on the READ side -- mutation-testing it away left the suite green. This is
	// the case that actually depends on it: the roster row is already canonical, and it is the
	// IDENTITY whose email arrives differently cased, which is exactly what an OAuth provider is
	// free to do.
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
	// Cycle detection recurses once per node. A long referral chain is a perfectly legal case
	// shape (and trivially producible by an imported file), so it must not blow the stack.
	it("validates a 5000-deep referral chain without overflowing the stack", () => {
		const personas = Array.from({ length: 5000 }, (_, i) =>
			personaPayload(`p${i}`),
		);
		const referrals = Array.from({ length: 4999 }, (_, i) =>
			referralEdge(`p${i}`, `p${i + 1}`, "next"),
		);
		expect(() => validateGraph(personas, referrals, ["p0"])).not.toThrow();
	});

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

	it("rejects a self-referral, which is a one-node cycle", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A")],
				[referralEdge("A", "A", "loop")],
				["A"],
			),
		).toThrow(/cycle/i);
	});

	// A case with personas but no roots is unreachable: startSimulation refuses it, so it should
	// never have been savable in the first place.
	it("REGRESSION: rejects a case with no root personas at save time", async () => {
		const t = newTestConvex();
		const admin = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ roots: [] }), admin)),
		).rejects.toThrow(/root/i);
	});

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
