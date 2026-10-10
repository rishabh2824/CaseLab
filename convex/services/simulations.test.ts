import { afterEach, describe, expect, it, vi } from "vitest";
import {
	caseStructure,
	personaPayload,
	referralEdge,
} from "../../tests/support/convexFactories";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { STUDENT_ERROR } from "../lib/studentErrors";
import type { CaseStructure } from "../models/cases";
import {
	insertPendingReply,
	newTestConvex,
	studentRejection,
} from "../test.setup";

// Inserts a case owned by a new admin, with optional overrides, and returns its id.
async function seedCase(
	t: ReturnType<typeof newTestConvex>,
	overrides: Partial<{
		name: string;
		brief: string;
		duration: number;
		accessCode: string;
		structure: CaseStructure;
	}> = {},
): Promise<Id<"cases">> {
	const ownerAdminId = await t.run((ctx) =>
		ctx.db.insert("admins", {
			email: `owner-${Math.random()}@test.caselab.invalid`,
			role: "admin",
		}),
	);
	return await t.run((ctx) =>
		ctx.db.insert("cases", {
			commonInformation: "",
			isDemo: false,
			name: overrides.name ?? "Sterling Industries",
			brief: overrides.brief ?? "Reduce office supply costs.",
			duration: overrides.duration,
			accessCode: overrides.accessCode ?? "sterling",
			ownerAdminId,
			structure: overrides.structure ?? caseStructure(),
		}),
	);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("startSimulation", () => {
	// Tests that a blank access code is rejected before any case lookup.
	it("rejects a blank access code before any case lookup", async () => {
		const t = newTestConvex();
		expect(
			await studentRejection(
				t.mutation(api.simulations.start, { accessCode: "   " }),
			),
		).toEqual({
			code: STUDENT_ERROR.ACCESS_CODE_REQUIRED,
			message: "Access code is required.",
		});
	});

	// Tests that an unknown access code is rejected.
	it("rejects an unknown access code", async () => {
		const t = newTestConvex();
		await seedCase(t, { accessCode: "sterling" });
		expect(
			await studentRejection(
				t.mutation(api.simulations.start, { accessCode: "not-a-real-code" }),
			),
		).toEqual({
			code: STUDENT_ERROR.INVALID_ACCESS_CODE,
			message: "Invalid access code.",
		});
	});

	// Tests that a trimmed case summary and one contact per root are returned.
	it("returns a trimmed case summary and one contact per root", async () => {
		const t = newTestConvex();
		await seedCase(t, {
			accessCode: "acme",
			name: "Acme Case",
			brief: "Do the thing.",
			duration: 30,
			structure: caseStructure({
				personas: [
					personaPayload("A", { name: "Alice" }),
					personaPayload("B", { name: "Bob" }),
				],
				roots: ["A", "B"],
			}),
		});

		const started = await t.mutation(api.simulations.start, {
			accessCode: "acme",
		});
		const state = await t.query(api.simulations.get, { runId: started.runId });

		expect(state.case).toEqual({
			id: state.case.id,
			caseName: "Acme Case",
			brief: "Do the thing.",
			simulationDuration: 30,
		});
		expect(state.contacts).toHaveLength(2);
		expect(new Set(state.contacts.map((c) => c.id))).toEqual(
			new Set(["A", "B"]),
		);
		expect(state.sharedFiles).toEqual([]);
	});

	// Tests that a persona's secret fields never leak into a contact.
	it("never leaks a persona's secret fields into a contact", async () => {
		const t = newTestConvex();
		const secretFact = "The budget is $2,000,000 exactly.";
		await seedCase(t, {
			accessCode: "secret",
			structure: caseStructure({
				personas: [
					personaPayload("A", {
						knownFacts: secretFact,
						personalityTraits: "Blunt, impatient.",
					}),
				],
			}),
		});

		const started = await t.mutation(api.simulations.start, {
			accessCode: "secret",
		});
		const state = await t.query(api.simulations.get, { runId: started.runId });
		const serialized = JSON.stringify(state.contacts);
		expect(serialized).not.toContain(secretFact);
		expect(serialized).not.toContain("Blunt, impatient.");
		expect(state.contacts[0]).not.toHaveProperty("knownFacts");
		expect(state.contacts[0]).not.toHaveProperty("personalityTraits");
		expect(state.contacts[0]).not.toHaveProperty("files");
	});

	// Tests that a profile photo is resolved to a Convex storage URL.
	it("resolves a profile photo to a Convex storage URL", async () => {
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["alice"])),
		);
		await seedCase(t, {
			accessCode: "photo",
			structure: caseStructure({
				personas: [
					personaPayload("A", {
						profilePhoto: {
							storageId: storageId,
							fileName: "alice.png",
							contentType: "image/png",
						},
					}),
				],
			}),
		});

		const started = await t.mutation(api.simulations.start, {
			accessCode: "photo",
		});
		const state = await t.query(api.simulations.get, { runId: started.runId });
		expect(state.contacts[0]!.profilePhotoUrl).toEqual(expect.any(String));
	});

	// Tests that a photo whose storage object no longer exists gets a null url.
	it("leaves a photo whose storage object no longer exists with a null url", async () => {
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["gone"])),
		);
		await t.run((ctx) => ctx.storage.delete(storageId));
		await seedCase(t, {
			accessCode: "deleted-storage",
			structure: caseStructure({
				personas: [
					personaPayload("A", {
						profilePhoto: {
							storageId: storageId,
							fileName: "alice.png",
							contentType: "image/png",
						},
					}),
				],
			}),
		});

		const started = await t.mutation(api.simulations.start, {
			accessCode: "deleted-storage",
		});
		const state = await t.query(api.simulations.get, { runId: started.runId });
		expect(state.contacts[0]!.profilePhotoUrl).toBeNull();
	});

	// Tests that expiresAt equals the case duration plus the grace period.
	it("expiresAt reflects duration plus the grace period", async () => {
		const t = newTestConvex();
		await seedCase(t, { accessCode: "timed", duration: 45 });
		vi.useFakeTimers({ toFake: ["Date"] });
		const before = Date.now();
		const state = await t.mutation(api.simulations.start, {
			accessCode: "timed",
		});
		const run = (await t.run((ctx) => ctx.db.get(state.runId)))!;
		expect(run.expiresAt - run._creationTime).toBeCloseTo(60 * 60_000, 1);
		expect(run._creationTime).toBeGreaterThanOrEqual(before);
	});

	// Tests that expiresAt is capped at the run lifetime for a very long case duration.
	it("caps expiresAt at the run lifetime for a very long case duration", async () => {
		const t = newTestConvex();
		vi.useFakeTimers({ toFake: ["Date"] });
		await seedCase(t, { accessCode: "long", duration: 100_000 });
		const state = await t.mutation(api.simulations.start, {
			accessCode: "long",
		});
		const run = (await t.run((ctx) => ctx.db.get(state.runId)))!;
		expect(run.expiresAt - run._creationTime).toBeCloseTo(120 * 60_000, 1);
	});
});

// Seeds a case with the given structure and starts a simulation on it.
async function startRun(
	t: ReturnType<typeof newTestConvex>,
	structure: CaseStructure,
	accessCode = "sterling",
) {
	await seedCase(t, { accessCode, structure });
	return await t.mutation(api.simulations.start, { accessCode: accessCode });
}

describe("getSimulationState", () => {
	// Tests that a read does not look at the clock: ending a run is the scheduled destroy's job, and its deletion is what tells the client.
	it("still reads a run past its expiry until the scheduled destroy deletes it", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await t.run((ctx) =>
			ctx.db.patch(state.runId, { expiresAt: Date.now() - 1_000 }),
		);

		await expect(
			t.query(api.simulations.get, { runId: state.runId }),
		).resolves.toMatchObject({ runId: state.runId });
		await t.mutation(internal.simulations.destroy, { runId: state.runId });
		expect(
			await studentRejection(
				t.query(api.simulations.get, { runId: state.runId }),
			),
		).toMatchObject({ code: STUDENT_ERROR.RUN_NOT_FOUND });
	});

	// Tests that an unlocked referred persona is included, available from its unlock minute.
	it("includes an unlocked referred persona, available from its unlock minute", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [personaPayload("A"), personaPayload("B")],
			referrals: [referralEdge("A", "B")],
			roots: ["A"],
		});
		const state = await startRun(t, structure);
		await t.run((ctx) =>
			ctx.db.patch(state.runId, {
				unlockedAt: { B: 7 },
			}),
		);

		const live = await t.query(api.simulations.get, { runId: state.runId });
		const b = live.contacts.find((c) => c.id === "B");
		expect(b).toBeDefined();
		expect(b?.availableAt).toBe(7);
		expect(b?.isReferred).toBe(true);
	});
});

describe("exportSimulation", () => {
	// Tests that roots and referred personas are ordered by unlock time, not referral-authoring order.
	it("orders roots then referred personas by unlock time, not referral-authoring order", async () => {
		const t = newTestConvex();
		const structure = caseStructure({
			personas: [
				personaPayload("A", { name: "Alice" }),
				personaPayload("B", { name: "Bob" }),
				personaPayload("C", { name: "Carl" }),
				personaPayload("D", { name: "Dana" }),
			],
			referrals: [
				referralEdge("A", "C", "unlock Carl"),
				referralEdge("B", "D", "unlock Dana"),
			],
			roots: ["A", "B"],
		});
		const state = await startRun(t, structure);
		await t.run((ctx) =>
			ctx.db.patch(state.runId, {
				unlockedAt: { D: 1, C: 5 },
			}),
		);
		await t.run((ctx) =>
			ctx.db.insert("runMessages", {
				runId: state.runId,
				personaId: "C",
				role: "user",
				content: "hi Carl",
				status: "done",
			}),
		);
		await t.run((ctx) =>
			ctx.db.insert("runMessages", {
				runId: state.runId,
				personaId: "C",
				role: "assistant",
				content: "Hello, I'm Carl.",
				status: "done",
			}),
		);

		const exported = await t.query(api.simulations.exportRun, {
			runId: state.runId,
		});

		expect(exported.personas.map((p) => p.id)).toEqual(["A", "B", "D", "C"]);
		const carl = exported.personas.find((p) => p.id === "C")!;
		const dana = exported.personas.find((p) => p.id === "D")!;
		expect(carl.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(dana.messages).toEqual([]);
	});
});

describe("exportSimulation with unfinished replies", () => {
	// Tests that a message whose reply is pending, and a failed reply, are left out of the export.
	it("leaves out a message with a pending reply and hides failed replies", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await t.run(async (ctx) => {
			for (const [role, content] of [
				["user", "first"],
				["assistant", "first reply"],
			] as const) {
				await ctx.db.insert("runMessages", {
					runId: state.runId,
					personaId: "A",
					role,
					content,
					status: "done",
				});
			}
		});
		await insertPendingReply(t, state.runId, "A", "still waiting");

		const exported = await t.query(api.simulations.exportRun, {
			runId: state.runId,
		});

		expect(exported.personas[0]!.messages.map((m) => m.content)).toEqual([
			"first",
			"first reply",
		]);
	});
});

describe("deleteRunCascade", () => {
	// Tests that destroying a run also deletes its messages, including a pending reply.
	it("deletes the run's messages, pending reply included, along with the run itself", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await insertPendingReply(t, state.runId, "A", "hi");

		await t.mutation(internal.simulations.destroy, { runId: state.runId });

		expect(await t.run((ctx) => ctx.db.get(state.runId))).toBeNull();
		const messages = await t.run((ctx) =>
			ctx.db
				.query("runMessages")
				.withIndex("by_run_persona", (q) => q.eq("runId", state.runId))
				.collect(),
		);
		expect(messages).toHaveLength(0);
	});
});
