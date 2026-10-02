import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { CaseStructure } from "../models/cases";
import { newTestConvex, sendTurn } from "../test.setup";
import { caseStructure, personaPayload } from "../testFactories";
import { deleteCase, updateCase } from "./cases";
import { startSimulation } from "./simulations";
import { startTurn } from "./turn";

type T = ReturnType<typeof newTestConvex>;

// Inserts an admin and a case they own, returning both.
async function seedCase(
	t: T,
	overrides: Partial<{
		accessCode: string;
		duration: number;
		structure: CaseStructure;
	}> = {},
): Promise<{ caseId: Id<"cases">; admin: Doc<"admins"> }> {
	const adminId = await t.run((ctx) =>
		ctx.db.insert("admins", {
			email: `owner-${Math.random().toString(36).slice(2)}@test.caselab.invalid`,
			role: "admin",
		}),
	);
	const caseId = await t.run((ctx) =>
		ctx.db.insert("cases", {
			name: "Sterling Industries",
			brief: "Reduce office supply costs.",
			duration: overrides.duration,
			accessCode: overrides.accessCode ?? "sterling",
			ownerAdminId: adminId,
			structure: overrides.structure ?? caseStructure(),
		}),
	);
	const admin = (await t.run((ctx) => ctx.db.get(adminId)))!;
	return { caseId, admin };
}

// Builds a valid case payload with optional overrides.
function payload(overrides: Record<string, unknown> = {}) {
	return {
		name: "Sterling Industries",
		brief: "Reduce office supply costs.",
		accessCode: "sterling",
		personas: [personaPayload("A")],
		referrals: [],
		roots: ["A"],
		collaboratorAdminIds: [] as Id<"admins">[],
		...overrides,
	};
}

describe("editing or deleting a case does not wait for its live runs", () => {
	// Tests that a case can be updated and deleted while a run is in progress.
	it("allows update and delete while a run is in progress", async () => {
		const t = newTestConvex();
		const { caseId, admin } = await seedCase(t);
		await t.run((ctx) => startSimulation(ctx, "sterling"));

		await expect(
			t.run((ctx) =>
				updateCase(ctx, caseId, payload({ name: "Renamed" }), admin),
			),
		).resolves.toBeNull();
		await expect(
			t.run((ctx) => deleteCase(ctx, caseId, admin)),
		).resolves.toBeNull();
	});
});

describe("run destruction is a terminal transition, and must tolerate being applied twice", () => {
	// Tests that destroying an already-destroyed run is a no-op rather than an error.
	it("destroy on an already-destroyed run is a no-op, not an error", async () => {
		const t = newTestConvex();
		await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));

		await t.mutation(internal.api.simulations.destroy, { runId: state.run_id });
		await expect(
			t.mutation(internal.api.simulations.destroy, { runId: state.run_id }),
		).resolves.toBeNull();
	});

	// Tests that destroying a run leaves no orphaned messages or turn streams.
	it("leaves no orphaned messages or turn streams behind", async () => {
		const t = newTestConvex();
		await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));
		await t.run(async (ctx) => {
			await ctx.db.insert("runMessages", {
				runId: state.run_id,
				personaKey: "A",
				role: "user",
				content: "hello",
			});
		});
		await t.run((ctx) => startTurn(ctx, state.run_id, "A", "hi"));

		await t.mutation(internal.api.simulations.destroy, { runId: state.run_id });

		const leftovers = await t.run(async (ctx) => ({
			run: await ctx.db.get(state.run_id),
			messages: await ctx.db.query("runMessages").collect(),
			turns: await ctx.db.query("turnStreams").collect(),
		}));
		expect(leftovers).toEqual({ run: null, messages: [], turns: [] });
	});

	// Tests that startSimulation schedules a destroy that really deletes the run when it fires.
	it("startSimulation schedules a destroy that actually deletes the run when it fires", async () => {
		vi.useFakeTimers();
		try {
			const t = newTestConvex();
			await seedCase(t, { duration: 5 });
			const state = await t.run((ctx) => startSimulation(ctx, "sterling"));

			await t.finishAllScheduledFunctions(vi.runAllTimers);

			expect(await t.run((ctx) => ctx.db.get(state.run_id))).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("reads against a run that has gone away", () => {
	// Tests that the student-scoped queries return gracefully instead of throwing on a destroyed run.
	it("the scoped student queries degrade gracefully rather than throwing on a destroyed run", async () => {
		const t = newTestConvex();
		await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));
		await t.mutation(internal.api.simulations.destroy, { runId: state.run_id });

		await expect(
			t.query(api.api.simulations.getPersonaHistory, {
				runId: state.run_id,
				personaId: "A",
			}),
		).resolves.toEqual([]);
		await expect(
			t.query(api.api.turn.getTurnStream, {
				runId: state.run_id,
				personaId: "A",
				withText: true,
			}),
		).resolves.toBeNull();
	});

	// Tests that the authoritative reads refuse an expired run without deleting it.
	it("the authoritative reads refuse an expired run without silently deleting it", async () => {
		const t = newTestConvex();
		await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, { expiresAt: Date.now() - 1 }),
		);

		await expect(
			t.query(api.api.simulations.get, { runId: state.run_id }),
		).rejects.toThrow("Run expired.");
		await expect(
			t.query(api.api.simulations.exportRun, { runId: state.run_id }),
		).rejects.toThrow("Run expired.");
		expect(await sendTurn(t, state.run_id, "A", "hi")).toMatchObject({
			status: 400,
			text: expect.stringContaining("Run expired."),
		});
		expect(await t.run((ctx) => ctx.db.get(state.run_id))).not.toBeNull();
	});

	// Tests that a run whose case was removed reports a case error instead of crashing.
	it("a run whose case was somehow removed reports a case error, not a crash", async () => {
		const t = newTestConvex();
		const { caseId } = await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));
		await t.run((ctx) => ctx.db.delete(caseId));

		await expect(
			t.query(api.api.simulations.get, { runId: state.run_id }),
		).rejects.toThrow("Case not found.");
	});
});
