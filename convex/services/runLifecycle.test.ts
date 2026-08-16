// The run lifecycle as a state machine: created -> live -> expired -> destroyed. Existing
// suites cover the happy path of each piece in isolation (simulations.test.ts's
// deleteRunCascade/deleteExpiredRuns); what's tested here is the transitions between them --
// expiry that the scheduler hasn't caught up with yet, the same terminal transition applied
// twice, and what happens to a run's read paths when its case is edited or deleted out from
// under it (updateCase/deleteCase no longer block on live runs -- see schema.ts's comment on
// `runs`).
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { newTestConvex } from "../test.setup";
import { caseStructure, personaPayload } from "../testFactories";
import { deleteCase, updateCase } from "./cases";
import { deleteExpiredRuns, startSimulation } from "./simulations";

type T = ReturnType<typeof newTestConvex>;

async function seedCase(
	t: T,
	overrides: Partial<{
		accessCode: string;
		duration: number;
		structure: unknown;
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

function payload(overrides: Record<string, unknown> = {}) {
	return {
		name: "Sterling Industries",
		brief: "Reduce office supply costs.",
		personas: [personaPayload("A")],
		referrals: [],
		roots: ["A"],
		collaboratorAdminIds: [] as Id<"admins">[],
		...overrides,
	};
}

describe("editing or deleting a case does not wait for its live runs", () => {
	// Blocking edits on a live run was an availability hole: simulations.start is
	// unauthenticated, so anyone with an access code could keep a case permanently uneditable.
	// The tradeoff is now the other way -- an admin who edits/deletes a case while a student is
	// mid-simulation is assumed to know the consequences (see schema.ts's comment on `runs`).
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
	// destroy is scheduled per-run at expiresAt, AND crons.ts sweeps expired rows weekly. Those
	// two paths can both target the same row (a destroy job delayed past the next sweep), so the
	// second one to run finds the row already gone. A bare ctx.db.delete on a missing id throws,
	// which surfaces as a failed scheduled function in production logs for a no-op.
	it("destroy on an already-destroyed run is a no-op, not an error", async () => {
		const t = newTestConvex();
		await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));

		await t.mutation(internal.api.simulations.destroy, { runId: state.run_id });
		await expect(
			t.mutation(internal.api.simulations.destroy, { runId: state.run_id }),
		).resolves.toBeNull();
	});

	it("the weekly sweep and a per-run destroy of the same expired row do not fight", async () => {
		const t = newTestConvex();
		await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));
		await t.run((ctx) =>
			ctx.db.patch(state.run_id, { expiresAt: Date.now() - 1 }),
		);

		expect(await t.run((ctx) => deleteExpiredRuns(ctx))).toBe(1);
		await expect(
			t.mutation(internal.api.simulations.destroy, { runId: state.run_id }),
		).resolves.toBeNull();
	});

	it("leaves no orphaned messages or streaming rows behind", async () => {
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
			await ctx.db.insert("streamingReplies", {
				runId: state.run_id,
				personaKey: "A",
				text: "partial",
				status: "streaming",
			});
		});

		await t.mutation(internal.api.simulations.destroy, { runId: state.run_id });

		const leftovers = await t.run(async (ctx) => ({
			run: await ctx.db.get(state.run_id),
			messages: await ctx.db.query("runMessages").collect(),
			streaming: await ctx.db.query("streamingReplies").collect(),
		}));
		expect(leftovers).toEqual({ run: null, messages: [], streaming: [] });
	});

	// The scheduled job is what makes the "no snapshot on a run" design safe (see schema.ts):
	// if it never fires, expired runs accumulate and hold their cases hostage. Prove the
	// scheduling itself is wired up, not just that the mutation works when called by hand.
	it("startSimulation schedules a destroy that actually deletes the run when it fires", async () => {
		vi.useFakeTimers();
		try {
			const t = newTestConvex();
			await seedCase(t, { duration: 5 });
			const state = await t.run((ctx) => startSimulation(ctx, "sterling"));

			const run = (await t.run((ctx) => ctx.db.get(state.run_id)))!;
			expect(run.destroyJobId).toBeDefined();

			await t.finishAllScheduledFunctions(vi.runAllTimers);

			expect(await t.run((ctx) => ctx.db.get(state.run_id))).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("reads against a run that has gone away", () => {
	it("the scoped student queries degrade gracefully rather than throwing on a destroyed run", async () => {
		const t = newTestConvex();
		await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));
		await t.mutation(internal.api.simulations.destroy, { runId: state.run_id });

		// getPersonaHistory/getStreamingPreview deliberately skip loadLiveRun -- the client's
		// getSimulationState subscription is what surfaces the expiry -- so they must answer
		// emptily rather than erroring, or a destroyed run turns into two competing error toasts.
		await expect(
			t.query(api.api.simulations.getPersonaHistory, {
				runId: state.run_id,
				personaId: "A",
			}),
		).resolves.toEqual([]);
		await expect(
			t.query(api.api.turn.getStreamingPreview, {
				runId: state.run_id,
				personaId: "A",
			}),
		).resolves.toBeNull();
	});

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
		await expect(
			t.mutation(api.api.turn.start, {
				runId: state.run_id,
				personaId: "A",
				message: "hi",
			}),
		).rejects.toThrow("Run expired.");
		expect(await t.run((ctx) => ctx.db.get(state.run_id))).not.toBeNull();
	});

	it("a run whose case was somehow removed reports a case error, not a crash", async () => {
		const t = newTestConvex();
		const { caseId } = await seedCase(t);
		const state = await t.run((ctx) => startSimulation(ctx, "sterling"));
		// deleteCase no longer blocks on a live run (schema.ts's comment on `runs`), so this is
		// now a directly reachable path, not just a modeled edge case.
		await t.run((ctx) => ctx.db.delete(caseId));

		await expect(
			t.query(api.api.simulations.get, { runId: state.run_id }),
		).rejects.toThrow("Case not found.");
	});
});
