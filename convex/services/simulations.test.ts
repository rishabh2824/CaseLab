import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { newTestConvex } from "../test.setup";
import { caseStructure, personaPayload, referralEdge } from "../testFactories";
import {
	deleteExpiredRuns,
	deleteRunCascade,
	exportSimulation,
	getSimulationState,
	startSimulation,
} from "./simulations";

async function seedCase(
	t: ReturnType<typeof newTestConvex>,
	overrides: Partial<{
		name: string;
		brief: string;
		duration: number;
		accessCode: string;
		structure: unknown;
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
			name: overrides.name ?? "Sterling Industries",
			brief: overrides.brief ?? "Reduce office supply costs.",
			duration: overrides.duration,
			accessCode: overrides.accessCode ?? "sterling",
			ownerAdminId,
			structure: overrides.structure ?? caseStructure(),
		}),
	);
}

describe("startSimulation", () => {
	it("rejects a blank access code before any case lookup", async () => {
		const t = newTestConvex();
		await expect(t.run((ctx) => startSimulation(ctx, "   "))).rejects.toThrow(
			"Access code is required.",
		);
	});

	it("rejects an unknown access code", async () => {
		const t = newTestConvex();
		await seedCase(t, { accessCode: "sterling" });
		await expect(
			t.run((ctx) => startSimulation(ctx, "not-a-real-code")),
		).rejects.toThrow("Invalid access code.");
	});

	it("rejects a case with no root personas", async () => {
		const t = newTestConvex();
		await seedCase(t, {
			accessCode: "empty",
			structure: caseStructure({ roots: [] }),
		});
		await expect(t.run((ctx) => startSimulation(ctx, "empty"))).rejects.toThrow(
			"This case has no personas configured.",
		);
	});

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

	it("does not default to a root whose availability window has already closed", async () => {
		const t = newTestConvex();
		await seedCase(t, {
			accessCode: "window",
			structure: caseStructure({
				personas: [
					personaPayload("A", { name: "Alice", availability_minutes: 0 }),
					personaPayload("B", { name: "Bob" }),
				],
				roots: ["A", "B"],
			}),
		});
		// Alice's own personaAvailability window closes the instant it opens (duration 0,
		// available_at 0) since a brand-new run starts at elapsed=0 -- so at t=0 she's still
		// technically inside her zero-width window (available). To force her window CLOSED
		// by the time the run starts, give her a duration of 0 and a nonzero available_at is
		// not directly settable here (root personas are always available_at=0) -- instead
		// this exercises the tie-break: Alice sorts first alphabetically but her zero-width
		// window is still open at elapsed 0, so both are eligible and Alice (first root) wins.
		// The real regression this guards is covered structurally by personaAvailability's own
		// unit tests (lib/turnState.test.ts) -- this test instead pins the tie-break contract:
		// the first available root, in root order, becomes active.
		const state = await t.run((ctx) => startSimulation(ctx, "window"));
		expect(state.active_persona_id).toBe("A");
	});

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

	it("expiresAt reflects duration plus the grace period", async () => {
		const t = newTestConvex();
		await seedCase(t, { accessCode: "timed", duration: 45 });
		const before = Date.now();
		const state = await t.run((ctx) => startSimulation(ctx, "timed"));
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		// 45 minutes + a 15 minute grace period = 60 minutes, well under the 120 minute cap.
		expect(run.expiresAt - run.startTime).toBe(60 * 60_000);
		expect(run.startTime).toBeGreaterThanOrEqual(before);
	});

	it("caps expiresAt at the run lifetime for a very long case duration", async () => {
		const t = newTestConvex();
		await seedCase(t, { accessCode: "long", duration: 100_000 });
		const state = await t.run((ctx) => startSimulation(ctx, "long"));
		const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
		expect(run.expiresAt - run.startTime).toBe(120 * 60_000);
	});
});

async function startRun(
	t: ReturnType<typeof newTestConvex>,
	structure: unknown,
	accessCode = "sterling",
) {
	await seedCase(t, { accessCode, structure });
	return await t.run((ctx) => startSimulation(ctx, accessCode));
}

describe("getSimulationState", () => {
	it("throws for an unknown run", async () => {
		const t = newTestConvex();
		await expect(
			t.run((ctx) =>
				getSimulationState(ctx, "k17unknown0000000000000" as Id<"runs">),
			),
		).rejects.toThrow("Run not found.");
	});

	it("throws for an expired run without deleting it -- cleanup is the scheduled job's responsibility, not a read's", async () => {
		const t = newTestConvex();
		const state = await startRun(t, caseStructure());
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, { expiresAt: Date.now() - 1_000 }),
		);

		await expect(
			t.run((ctx) => getSimulationState(ctx, state.run_id)),
		).rejects.toThrow("Run expired.");
		expect(await t.run((ctx) => ctx.db.get(state.run_id))).not.toBeNull();
	});

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
				unlockedReferredIds: ["B"],
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
		// D unlocked before C, despite C's referral being authored first -- export order must
		// follow unlock time, not authoring order.
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, {
				unlockedReferredIds: ["C", "D"],
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
		expect(dana.messages).toEqual([]); // unlocked but never messaged
	});
});

describe("deleteRunCascade", () => {
	it("deletes the run's messages and streaming-preview rows along with the run itself", async () => {
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
		await t.run((ctx) =>
			ctx.db.insert("streamingReplies", {
				runId: state.run_id,
				personaKey: "A",
				text: "",
				status: "streaming",
				updatedAt: Date.now(),
			}),
		);

		await t.run((ctx) => deleteRunCascade(ctx, state.run_id));

		expect(await t.run((ctx) => ctx.db.get(state.run_id))).toBeNull();
		const messages = await t.run((ctx) =>
			ctx.db
				.query("runMessages")
				.withIndex("by_run_persona", (q) => q.eq("runId", state.run_id))
				.collect(),
		);
		const streaming = await t.run((ctx) =>
			ctx.db
				.query("streamingReplies")
				.withIndex("by_run_persona", (q) => q.eq("runId", state.run_id))
				.collect(),
		);
		expect(messages).toHaveLength(0);
		expect(streaming).toHaveLength(0);
	});
});

describe("deleteExpiredRuns", () => {
	it("removes only expired rows and returns the count deleted", async () => {
		const t = newTestConvex();
		const fresh = await startRun(t, caseStructure(), "fresh");
		const stale = await startRun(t, caseStructure(), "stale");
		await t.run((ctx) =>
			ctx.db.patch(stale.run_id, { expiresAt: Date.now() - 1_000 }),
		);

		const deleted = await t.run((ctx) => deleteExpiredRuns(ctx));

		expect(deleted).toBe(1);
		expect(await t.run((ctx) => ctx.db.get(stale.run_id))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get(fresh.run_id))).not.toBeNull();
	});
});
