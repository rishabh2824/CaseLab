import { afterEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { STUDENT_ERROR } from "../lib/studentErrors";
import type { CaseStructure } from "../models/cases";
import { newTestConvex, studentRejection } from "../test.setup";
import { caseStructure, personaPayload, referralEdge } from "../testFactories";
import {
	deleteRunCascade,
	exportSimulation,
	getSimulationState,
	startSimulation,
} from "./simulations";
import { startTurn } from "./turn";

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
			await studentRejection(t.run((ctx) => startSimulation(ctx, "   "))),
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
				t.run((ctx) => startSimulation(ctx, "not-a-real-code")),
			),
		).toEqual({
			code: STUDENT_ERROR.INVALID_ACCESS_CODE,
			message: "Invalid access code.",
		});
	});

	// Tests that a case with no root personas is rejected.
	it("rejects a case with no root personas", async () => {
		const t = newTestConvex();
		await seedCase(t, {
			accessCode: "empty",
			structure: caseStructure({ roots: [] }),
		});
		expect(
			await studentRejection(t.run((ctx) => startSimulation(ctx, "empty"))),
		).toEqual({
			code: STUDENT_ERROR.NO_PERSONAS,
			message: "This case has no personas configured.",
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

		const state = await t.run((ctx) => startSimulation(ctx, "acme"));

		expect(state.case).toEqual({
			id: state.case.id,
			case_name: "Acme Case",
			brief: "Do the thing.",
			simulation_duration: 30,
		});
		expect(state.contacts).toHaveLength(2);
		expect(new Set(state.contacts.map((c) => c.id))).toEqual(
			new Set(["A", "B"]),
		);
		expect(state.shared_files).toEqual([]);
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
						known_facts: secretFact,
						personality_traits: "Blunt, impatient.",
					}),
				],
			}),
		});

		const state = await t.run((ctx) => startSimulation(ctx, "secret"));
		const serialized = JSON.stringify(state.contacts);
		expect(serialized).not.toContain(secretFact);
		expect(serialized).not.toContain("Blunt, impatient.");
		expect(state.contacts[0]).not.toHaveProperty("known_facts");
		expect(state.contacts[0]).not.toHaveProperty("personality_traits");
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
						profile_photo: {
							storage_id: storageId,
							file_name: "alice.png",
							content_type: "image/png",
						},
					}),
				],
			}),
		});

		const state = await t.run((ctx) => startSimulation(ctx, "photo"));
		expect(state.contacts[0]!.profile_photo?.url).toEqual(expect.any(String));
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
						profile_photo: {
							storage_id: storageId,
							file_name: "alice.png",
							content_type: "image/png",
						},
					}),
				],
			}),
		});

		const state = await t.run((ctx) => startSimulation(ctx, "deleted-storage"));
		expect(state.contacts[0]!.profile_photo?.url).toBeNull();
	});

	// Tests that expiresAt equals the case duration plus the grace period.
	it("expiresAt reflects duration plus the grace period", async () => {
		const t = newTestConvex();
		await seedCase(t, { accessCode: "timed", duration: 45 });
		vi.useFakeTimers({ toFake: ["Date"] });
		const before = Date.now();
		const state = await t.run((ctx) => startSimulation(ctx, "timed"));
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.expiresAt - run._creationTime).toBeCloseTo(60 * 60_000, 1);
		expect(run._creationTime).toBeGreaterThanOrEqual(before);
	});

	// Tests that expiresAt is capped at the run lifetime for a very long case duration.
	it("caps expiresAt at the run lifetime for a very long case duration", async () => {
		const t = newTestConvex();
		vi.useFakeTimers({ toFake: ["Date"] });
		await seedCase(t, { accessCode: "long", duration: 100_000 });
		const state = await t.run((ctx) => startSimulation(ctx, "long"));
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
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
	return await t.run((ctx) => startSimulation(ctx, accessCode));
}

describe("getSimulationState", () => {
	// Tests that reading an unknown run throws.
	it("throws for an unknown run", async () => {
		const t = newTestConvex();
		expect(
			await studentRejection(
				t.run((ctx) =>
					getSimulationState(ctx, "k17unknown0000000000000" as Id<"runs">),
				),
			),
		).toEqual({
			code: STUDENT_ERROR.RUN_NOT_FOUND,
			message: "Run not found.",
		});
	});

	// Tests that reading an expired run throws without deleting it.
	it("throws for an expired run without deleting it -- cleanup is the scheduled job's responsibility, not a read's", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, { expiresAt: Date.now() - 1_000 }),
		);

		expect(
			await studentRejection(
				t.run((ctx) => getSimulationState(ctx, state.run_id)),
			),
		).toEqual({
			code: STUDENT_ERROR.RUN_EXPIRED,
			message: "Run expired.",
		});
		expect(await t.run((ctx) => ctx.db.get(state.run_id))).not.toBeNull();
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
			ctx.db.patch(state.run_id, {
				unlockedAt: { B: 7 },
			}),
		);

		const live = await t.run((ctx) => getSimulationState(ctx, state.run_id));
		const b = live.contacts.find((c) => c.id === "B");
		expect(b).toBeDefined();
		expect(b?.available_at).toBe(7);
		expect(b?.is_referred).toBe(true);
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
			ctx.db.patch(state.run_id, {
				unlockedAt: { D: 1, C: 5 },
			}),
		);
		await t.run((ctx) =>
			ctx.db.insert("runMessages", {
				runId: state.run_id,
				personaKey: "C",
				role: "user",
				content: "hi Carl",
			}),
		);
		await t.run((ctx) =>
			ctx.db.insert("runMessages", {
				runId: state.run_id,
				personaKey: "C",
				role: "assistant",
				content: "Hello, I'm Carl.",
			}),
		);

		const exported = await t.run((ctx) => exportSimulation(ctx, state.run_id));

		expect(exported.personas.map((p) => p.id)).toEqual(["A", "B", "D", "C"]);
		const carl = exported.personas.find((p) => p.id === "C")!;
		const dana = exported.personas.find((p) => p.id === "D")!;
		expect(carl.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(dana.messages).toEqual([]);
	});
});

describe("deleteRunCascade", () => {
	// Tests that destroying a run also deletes its messages and turn streams.
	it("deletes the run's messages and turn streams along with the run itself", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await t.run((ctx) =>
			ctx.db.insert("runMessages", {
				runId: state.run_id,
				personaKey: "A",
				role: "user",
				content: "hi",
			}),
		);
		await t.run((ctx) => startTurn(ctx, state.run_id, "A", "hi"));
		const { streamId } = (await t.run((ctx) =>
			ctx.db.query("turnStreams").first(),
		))!;

		await t.run((ctx) => deleteRunCascade(ctx, state.run_id));

		expect(await t.run((ctx) => ctx.db.get(state.run_id))).toBeNull();
		const messages = await t.run((ctx) =>
			ctx.db
				.query("runMessages")
				.withIndex("by_run_persona", (q) => q.eq("runId", state.run_id))
				.collect(),
		);
		const turns = await t.run((ctx) =>
			ctx.db
				.query("turnStreams")
				.withIndex("by_run_persona", (q) => q.eq("runId", state.run_id))
				.collect(),
		);
		expect(messages).toHaveLength(0);
		expect(turns).toHaveLength(0);
		await expect(
			t.query(components.persistentTextStreaming.lib.getStreamText, {
				streamId,
			}),
		).rejects.toThrow("Stream not found");
	});
});
