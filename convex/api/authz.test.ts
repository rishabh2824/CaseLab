import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { CaseStructure } from "../models/cases";
import { newTestConvex, withAdmin, withStranger } from "../test.setup";
import { caseStructure, personaPayload } from "../testFactories";

type T = ReturnType<typeof newTestConvex>;

// Inserts a case owned by the given admin, with optional name, access code and structure overrides.
async function seedCase(
	t: T,
	ownerAdminId: Id<"admins">,
	overrides: Partial<{
		name: string;
		accessCode: string;
		structure: CaseStructure;
	}> = {},
): Promise<Id<"cases">> {
	return await t.run((ctx) =>
		ctx.db.insert("cases", {
			commonInformation: "",
			isDemo: false,
			name: overrides.name ?? "Owned Case",
			brief: "A brief.",
			accessCode: overrides.accessCode ?? "seedcode",
			ownerAdminId,
			structure: overrides.structure ?? caseStructure(),
		}),
	);
}

// Builds a valid case create/update payload with optional overrides.
function casePayloadArgs(overrides: Record<string, unknown> = {}) {
	return {
		name: "Case",
		brief: "Brief",
		commonInformation: "",
		accessCode: "authztestcode",
		personas: [personaPayload("A")],
		referrals: [],
		roots: ["A"],
		collaboratorAdminIds: [] as Id<"admins">[],
		...overrides,
	};
}

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
			["cases.getDemo", () => t.query(api.api.cases.getDemo, { caseId })],
			["cases.listDemos", () => t.query(api.api.cases.listDemos, {})],
			[
				"cases.setDemo",
				() => t.mutation(api.api.cases.setDemo, { caseId, isDemo: true }),
			],
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
				"uploads.generateUploadUrls",
				() => t.mutation(api.api.uploads.generateUploadUrls, { count: 2 }),
			],
			[
				"uploads.discardUploads",
				() => t.mutation(api.api.uploads.discardUploads, { storageIds: [] }),
			],
		] as const;
	}

	// Tests that every admin function rejects a caller with no identity.
	it("rejects every admin function for a caller with no identity at all", async () => {
		const t = newTestConvex();
		const failures: string[] = [];
		for (const [name, call] of await anonymousCallers(t)) {
			try {
				await call();
				failures.push(name);
			} catch {}
		}
		expect(failures).toEqual([]);
	});

	// Tests that every admin function rejects a signed-in Google user who has no admins row.
	it("rejects every admin function for an authenticated Google user with no admins row", async () => {
		const t = newTestConvex();
		const asStranger = await withStranger(t, "stranger@test.caselab.invalid");
		const adminId = await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: "owner@test.caselab.invalid",
				role: "admin",
			}),
		);
		const caseId = await seedCase(t, adminId);

		const calls: [string, () => Promise<unknown>][] = [
			[
				"cases.getDemo",
				() => asStranger.query(api.api.cases.getDemo, { caseId }),
			],
			["cases.listDemos", () => asStranger.query(api.api.cases.listDemos, {})],
			[
				"cases.setDemo",
				() =>
					asStranger.mutation(api.api.cases.setDemo, { caseId, isDemo: true }),
			],
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
		];
		const failures: string[] = [];
		for (const [name, call] of calls) {
			try {
				await call();
				failures.push(name);
			} catch {}
		}
		expect(failures).toEqual([]);
	});

	// Tests that viewer returns null for anonymous and non-admin callers instead of throwing or leaking.
	it("viewer returns null (rather than throwing or leaking) for anonymous and non-admin callers", async () => {
		const t = newTestConvex();
		expect(await t.query(api.api.admins.viewer, {})).toBeNull();

		const asStranger = await withStranger(t, "stranger@test.caselab.invalid");
		expect(await asStranger.query(api.api.admins.viewer, {})).toBeNull();
	});

	// Tests that an admin loses access as soon as their admins row is deleted.
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
	// Tests that a non-owner is denied every ownership-gated case operation by id.
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

	// Tests that getForEdit does not expose another admin's access code and persona secrets to an unrelated admin.
	it("REGRESSION: cases.getForEdit must not hand another admin's access code and persona secrets to an unrelated admin", async () => {
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
			outsider.asUser.query(api.api.cases.getForEdit, { caseId }),
		).rejects.toThrow(/access/i);
	});

	// Tests that getDemo only serves cases flagged as demos, so it cannot read a private case of another admin.
	it("getDemo does not expose a private case of another admin", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner6@test.caselab.invalid" });
		const outsider = await withAdmin(t, {
			email: "outsider6@test.caselab.invalid",
		});
		const caseId = await seedCase(t, owner.adminId, {
			accessCode: "privatecode",
		});

		await expect(
			outsider.asUser.query(api.api.cases.getDemo, { caseId }),
		).resolves.toBeNull();
	});

	// Tests that a collaborator gets access to a case while an admin who was never added is refused.
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
			}),
		);

		await expect(
			collaborator.asUser.query(api.api.cases.getForEdit, { caseId }),
		).resolves.toMatchObject({ _id: caseId });
		await expect(
			outsider.asUser.query(api.api.cases.getForEdit, { caseId }),
		).rejects.toThrow("You do not have access to this case.");
	});

	// Tests that a collaborator cannot take ownership of a case through update.
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
	// Tests that a regular admin cannot create or delete admins, including elevating themselves.
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

		const roster = await regular.asUser.query(api.api.admins.listAll, {});
		expect(roster.map((a) => a.email).sort()).toEqual([
			"regular@test.caselab.invalid",
			"victim@test.caselab.invalid",
		]);
	});

	// Tests that a super admin cannot be deleted by anyone.
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

	// Tests that a super admin bypasses per-case ownership while a regular admin never does.
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

	// Tests that the student-facing functions work without any identity.
	it("start/get/getPersonaHistory/exportRun/getTurnStream all work with no identity", async () => {
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
			t.query(api.api.turn.getTurnStream, {
				runId: state.run_id,
				personaId: "A",
				withText: true,
			}),
		).resolves.toBeNull();
	});

	// Tests that one run's id can never read another run's transcript, contacts or export.
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

	// Tests that every state-mutating turn/simulation function is declared internal rather than public.
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

		expect(publicExports(turnSource)).toEqual(["getTurnStream"]);
		expect(publicExports(simulationsSource)).toEqual([
			"exportRun",
			"get",
			"getPersonaHistory",
			"start",
		]);
	});
});

describe("every export in the admin-facing api/ modules is gated or internal", () => {
	const ADMIN_WRAPPERS = new Set([
		"adminQuery",
		"adminMutation",
		"superAdminMutation",
	]);
	const UNGATED_EXCEPTIONS = new Set(["admins.viewer"]);

	// Tests that every export in the admins/cases/uploads/files modules uses an admin wrapper or is internal.
	it("uses an admin wrapper, or is internal, for every export in admins/cases/uploads/files", async () => {
		const moduleNames = ["admins", "cases", "uploads", "files"];
		const sources = await Promise.all(
			moduleNames.map((name) =>
				import(`./${name}.ts?raw`).then((m) => m.default as string),
			),
		);

		const ungated: string[] = [];
		moduleNames.forEach((moduleName, i) => {
			for (const [, name, wrapper] of sources[i]!.matchAll(
				/export const (\w+) = (\w+)\(/g,
			)) {
				const qualified = `${moduleName}.${name}`;
				if (UNGATED_EXCEPTIONS.has(qualified)) {
					expect(wrapper).toBe("query");
					continue;
				}
				if (!ADMIN_WRAPPERS.has(wrapper!) && !wrapper!.startsWith("internal")) {
					ungated.push(`${qualified} (${wrapper})`);
				}
			}
		});
		expect(ungated).toEqual([]);
	});
});
