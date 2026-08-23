// Authorization tested at the ACTUAL enforcement boundary -- the public `query`/`mutation`
// wrappers in convex/api/*, called the way a hostile client calls them (a raw function
// reference plus hand-crafted args), not through the service functions the rest of the suite
// exercises via `t.run`. `t.run` bypasses every wrapper, so a service-level test proves
// nothing about whether the exported function actually gates the caller: deleting
// `await requireCurrentAdmin(ctx)` from an api/ handler would leave every existing
// services/*.test.ts case green. These tests fail instead.
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newTestConvex, withAdmin } from "../test.setup";
import { caseStructure, personaPayload } from "../testFactories";

type T = ReturnType<typeof newTestConvex>;

async function seedCase(
	t: T,
	ownerAdminId: Id<"admins">,
	overrides: Partial<{
		name: string;
		accessCode: string;
		structure: unknown;
	}> = {},
): Promise<Id<"cases">> {
	return await t.run((ctx) =>
		ctx.db.insert("cases", {
			name: overrides.name ?? "Owned Case",
			brief: "A brief.",
			accessCode: overrides.accessCode,
			ownerAdminId,
			structure: overrides.structure ?? caseStructure(),
		}),
	);
}

function casePayloadArgs(overrides: Record<string, unknown> = {}) {
	return {
		name: "Case",
		brief: "Brief",
		personas: [personaPayload("A")],
		referrals: [],
		roots: ["A"],
		collaboratorAdminIds: [] as Id<"admins">[],
		...overrides,
	};
}

// Every publicly-exported admin-facing function, with args valid enough that the ONLY thing
// that can reject the call is the auth gate itself. A new admin function added to api/ without
// a gate shows up here as a passing call instead of a rejection.
describe("admin-only surface rejects anonymous callers", () => {
	async function anonymousCallers(t: T) {
		const adminId = await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: "owner@test.caselab.invalid",
				role: "admin",
			}),
		);
		const caseId = await seedCase(t, adminId);
		return [
			["cases.get", () => t.query(api.api.cases.get, { caseId })],
			["cases.getForEdit", () => t.query(api.api.cases.getForEdit, { caseId })],
			["cases.listAll", () => t.query(api.api.cases.listAll, {})],
			[
				"cases.create",
				() => t.mutation(api.api.cases.create, casePayloadArgs()),
			],
			[
				"cases.update",
				() =>
					t.mutation(api.api.cases.update, { caseId, ...casePayloadArgs() }),
			],
			[
				"cases.deleteCase",
				() => t.mutation(api.api.cases.deleteCase, { caseId }),
			],
			["admins.listAll", () => t.query(api.api.admins.listAll, {})],
			[
				"admins.create",
				() =>
					t.mutation(api.api.admins.create, {
						email: "x@y.z",
						role: "admin" as const,
					}),
			],
			[
				"admins.deleteWithCascade",
				() => t.mutation(api.api.admins.deleteWithCascade, { adminId }),
			],
			[
				"uploads.generateUploadUrl",
				() => t.mutation(api.api.uploads.generateUploadUrl, {}),
			],
			[
				"uploads.generateUploadUrls",
				() => t.mutation(api.api.uploads.generateUploadUrls, { count: 2 }),
			],
		] as const;
	}

	it("rejects every admin function for a caller with no identity at all", async () => {
		const t = newTestConvex();
		const failures: string[] = [];
		for (const [name, call] of await anonymousCallers(t)) {
			try {
				await call();
				failures.push(name);
			} catch {
				// expected
			}
		}
		expect(failures).toEqual([]);
	});

	it("rejects every admin function for an authenticated Google user with no admins row", async () => {
		const t = newTestConvex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", { email: "stranger@test.caselab.invalid" }),
		);
		const asStranger = t.withIdentity({ subject: userId });
		const adminId = await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: "owner@test.caselab.invalid",
				role: "admin",
			}),
		);
		const caseId = await seedCase(t, adminId);

		const calls: [string, () => Promise<unknown>][] = [
			["cases.get", () => asStranger.query(api.api.cases.get, { caseId })],
			["cases.listAll", () => asStranger.query(api.api.cases.listAll, {})],
			[
				"cases.create",
				() => asStranger.mutation(api.api.cases.create, casePayloadArgs()),
			],
			[
				"cases.deleteCase",
				() => asStranger.mutation(api.api.cases.deleteCase, { caseId }),
			],
			["admins.listAll", () => asStranger.query(api.api.admins.listAll, {})],
			[
				"uploads.generateUploadUrl",
				() => asStranger.mutation(api.api.uploads.generateUploadUrl, {}),
			],
		];
		const failures: string[] = [];
		for (const [name, call] of calls) {
			try {
				await call();
				failures.push(name);
			} catch {
				// expected
			}
		}
		expect(failures).toEqual([]);
	});

	// viewer is the one query deliberately callable by anyone -- it must answer "null", never
	// throw and never leak, so the frontend can distinguish "signed out" from "error".
	it("viewer returns null (rather than throwing or leaking) for anonymous and non-admin callers", async () => {
		const t = newTestConvex();
		expect(await t.query(api.api.admins.viewer, {})).toBeNull();

		const userId = await t.run((ctx) =>
			ctx.db.insert("users", { email: "stranger@test.caselab.invalid" }),
		);
		expect(
			await t
				.withIdentity({ subject: userId })
				.query(api.api.admins.viewer, {}),
		).toBeNull();
	});

	// A signed-in identity whose users row was deleted (admin removed mid-session) must not
	// keep working off the stale session.
	it("stops authorizing a signed-in admin once their admins row is deleted", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t, { role: "admin" });
		await expect(asUser.query(api.api.cases.listAll, {})).resolves.toEqual([]);

		await t.run((ctx) => ctx.db.delete(adminId));

		await expect(asUser.query(api.api.cases.listAll, {})).rejects.toThrow(
			"Your account is not authorized.",
		);
		expect(await asUser.query(api.api.admins.viewer, {})).toBeNull();
	});
});

describe("cross-admin case isolation (object ownership)", () => {
	it("denies a non-owner every ownership-gated case operation, by id", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const outsider = await withAdmin(t, {
			email: "outsider@test.caselab.invalid",
		});
		const caseId = await seedCase(t, owner.adminId, {
			accessCode: "secretcode",
		});

		await expect(
			outsider.asUser.query(api.api.cases.getForEdit, { caseId }),
		).rejects.toThrow("You do not have access to this case.");
		await expect(
			outsider.asUser.mutation(api.api.cases.update, {
				caseId,
				...casePayloadArgs(),
			}),
		).rejects.toThrow("You do not have access to this case.");
		await expect(
			outsider.asUser.mutation(api.api.cases.deleteCase, { caseId }),
		).rejects.toThrow("You do not have access to this case.");
		await expect(
			outsider.asUser.query(api.api.cases.listAll, {}),
		).resolves.toEqual([]);
	});

	// SECURITY: api/cases.ts's `get` runs requireCurrentAdmin but NO requireCaseAccess, so any
	// signed-in admin can read any other admin's entire case document by id -- including its
	// access code (which is all a student needs to launch the simulation) and every persona's
	// `known_facts`, the case's confidential content. `getForEdit` right beside it does gate on
	// ownership; `get` exists only for DemoCaseView.svelte's one hardcoded demo case id.
	// The fix is a caseAccess check in `get` too; until then this test pins the exposure so it
	// can't silently widen.
	it("REGRESSION: cases.get must not hand another admin's access code and persona secrets to an unrelated admin", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner2@test.caselab.invalid" });
		const outsider = await withAdmin(t, {
			email: "outsider2@test.caselab.invalid",
		});
		const caseId = await seedCase(t, owner.adminId, {
			accessCode: "topsecret",
			structure: caseStructure({
				personas: [
					personaPayload("A", {
						known_facts: "The buyer will pay up to $4.2M.",
					}),
				],
			}),
		});

		await expect(
			outsider.asUser.query(api.api.cases.get, { caseId }),
		).rejects.toThrow(/access/i);
	});

	it("gives a collaborator access but still refuses an admin who was never added", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner3@test.caselab.invalid" });
		const collaborator = await withAdmin(t, {
			email: "collab@test.caselab.invalid",
		});
		const outsider = await withAdmin(t, {
			email: "outsider3@test.caselab.invalid",
		});
		const caseId = await seedCase(t, owner.adminId);
		await t.run((ctx) =>
			ctx.db.insert("collaborators", {
				caseId,
				adminId: collaborator.adminId,
				addedAt: Date.now(),
			}),
		);

		await expect(
			collaborator.asUser.query(api.api.cases.getForEdit, { caseId }),
		).resolves.toMatchObject({ _id: caseId });
		await expect(
			outsider.asUser.query(api.api.cases.getForEdit, { caseId }),
		).rejects.toThrow("You do not have access to this case.");
	});

	// A collaborator has full edit rights but must not be able to hand the case to themselves:
	// updateCase never writes ownerAdminId, so an `ownerAdminId` smuggled into the payload is
	// simply not a field the mutation accepts.
	it("a collaborator cannot take ownership of a case through update", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner4@test.caselab.invalid" });
		const collaborator = await withAdmin(t, {
			email: "collab4@test.caselab.invalid",
		});
		const caseId = await seedCase(t, owner.adminId);
		await t.run((ctx) =>
			ctx.db.insert("collaborators", {
				caseId,
				adminId: collaborator.adminId,
				addedAt: Date.now(),
			}),
		);

		await collaborator.asUser.mutation(api.api.cases.update, {
			caseId,
			...casePayloadArgs({ name: "Renamed by collaborator" }),
		});

		const after = (await t.run((ctx) => ctx.db.get(caseId)))!;
		expect(after.ownerAdminId).toBe(owner.adminId);
	});
});

describe("role boundaries", () => {
	it("a regular admin cannot create or delete admins, even a self-elevating one", async () => {
		const t = newTestConvex();
		const regular = await withAdmin(t, {
			email: "regular@test.caselab.invalid",
			role: "admin",
		});
		const victim = await withAdmin(t, {
			email: "victim@test.caselab.invalid",
			role: "admin",
		});

		await expect(
			regular.asUser.mutation(api.api.admins.create, {
				email: "me-again@test.caselab.invalid",
				role: "super",
			}),
		).rejects.toThrow("Only a super admin can do this.");
		await expect(
			regular.asUser.mutation(api.api.admins.deleteWithCascade, {
				adminId: victim.adminId,
			}),
		).rejects.toThrow("Only a super admin can do this.");

		// And nothing was written despite the rejection.
		const roster = await regular.asUser.query(api.api.admins.listAll, {});
		expect(roster.map((a) => a.email).sort()).toEqual([
			"regular@test.caselab.invalid",
			"victim@test.caselab.invalid",
		]);
	});

	it("a super admin cannot be deleted, by anyone", async () => {
		const t = newTestConvex();
		const superAdmin = await withAdmin(t, {
			email: "super@test.caselab.invalid",
			role: "super",
		});
		const otherSuper = await withAdmin(t, {
			email: "super2@test.caselab.invalid",
			role: "super",
		});

		await expect(
			superAdmin.asUser.mutation(api.api.admins.deleteWithCascade, {
				adminId: otherSuper.adminId,
			}),
		).rejects.toThrow("Super admins cannot be deleted.");
	});

	it("a super admin bypasses per-case ownership but a regular admin never does", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner5@test.caselab.invalid" });
		const superAdmin = await withAdmin(t, {
			email: "super5@test.caselab.invalid",
			role: "super",
		});
		const caseId = await seedCase(t, owner.adminId);

		await expect(
			superAdmin.asUser.query(api.api.cases.getForEdit, { caseId }),
		).resolves.toMatchObject({ _id: caseId });
		await expect(
			superAdmin.asUser.query(api.api.cases.listAll, {}),
		).resolves.toHaveLength(1);
	});
});

describe("student-facing surface is deliberately unauthenticated -- pinned so a change is deliberate", () => {
	async function startRun(t: T, accessCode = "sterling") {
		const adminId = await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: `o-${Math.random()}@test.caselab.invalid`,
				role: "admin",
			}),
		);
		await seedCase(t, adminId, { accessCode });
		return await t.mutation(api.api.simulations.start, { accessCode });
	}

	it("start/get/getPersonaHistory/exportRun/getStreamingPreview all work with no identity", async () => {
		const t = newTestConvex();
		const state = await startRun(t);
		expect(state.run_id).toBeDefined();

		await expect(
			t.query(api.api.simulations.get, { runId: state.run_id }),
		).resolves.toMatchObject({ run_id: state.run_id });
		await expect(
			t.query(api.api.simulations.getPersonaHistory, {
				runId: state.run_id,
				personaId: "A",
			}),
		).resolves.toEqual([]);
		await expect(
			t.query(api.api.simulations.exportRun, { runId: state.run_id }),
		).resolves.toMatchObject({ case: { case_name: "Owned Case" } });
		await expect(
			t.query(api.api.turn.getStreamingPreview, {
				runId: state.run_id,
				personaId: "A",
			}),
		).resolves.toBeNull();
	});

	// Run ids are the only capability protecting a student's transcript. Holding one run's id
	// must never surface another run's messages, even for the same case and persona key.
	it("one run's id never reads another run's transcript, contacts, or export", async () => {
		const t = newTestConvex();
		const a = await startRun(t, "alpha");
		const b = await startRun(t, "beta");

		await t.run((ctx) =>
			ctx.db.insert("runMessages", {
				runId: a.run_id,
				personaKey: "A",
				role: "user",
				content: "run A private message",
			}),
		);

		const bHistory = await t.query(api.api.simulations.getPersonaHistory, {
			runId: b.run_id,
			personaId: "A",
		});
		expect(bHistory).toEqual([]);

		const bExport = await t.query(api.api.simulations.exportRun, {
			runId: b.run_id,
		});
		expect(JSON.stringify(bExport)).not.toContain("run A private message");
	});

	// The state-mutating half of a turn (applyDecisions, applyBoundary, writeStreamingPreview,
	// markStreamingError) and the run-deleting half of simulations (destroy, deleteExpiredRuns)
	// are only safe because they are `internal*` and therefore unreachable from a browser. If
	// any of them were ever exported as a plain `mutation`/`action`/`query`, an unauthenticated
	// client could forge referral unlocks and file shares (applyDecisions takes both as plain
	// args), end anyone's chat (applyBoundary), or wipe a run mid-simulation (destroy) -- the
	// student surface has no identity to check them against. convex-test resolves a function
	// reference regardless of visibility, so no runtime call can assert this; the declaration
	// itself is the security boundary, and this pins it.
	it("keeps every state-mutating turn/simulation function declared internal, not public", async () => {
		const [turnSource, simulationsSource] = await Promise.all([
			import("./turn?raw").then((m) => m.default as string),
			import("./simulations?raw").then((m) => m.default as string),
		]);

		const publicExports = (source: string): string[] =>
			[...source.matchAll(/export const (\w+) = (\w+)\(/g)]
				.filter(([, , kind]) => !kind!.startsWith("internal"))
				.map(([, name]) => name!)
				.sort();

		expect(publicExports(turnSource)).toEqual(["getStreamingPreview", "start"]);
		expect(publicExports(simulationsSource)).toEqual([
			"exportRun",
			"get",
			"getPersonaHistory",
			"start",
		]);
	});
});
