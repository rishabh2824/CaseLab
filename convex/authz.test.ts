/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import {
	caseStructure,
	personaPayload,
} from "../tests/support/convexFactories";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { CaseStructure } from "./models/cases";
import { newTestConvex, withAdmin, withStranger } from "./test.setup";

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
		structure: {
			personas: [personaPayload("A")],
			referrals: [],
			roots: ["A"],
		},
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
			["cases.getDemo", () => t.query(api.cases.getDemo, { caseId })],
			["cases.listDemos", () => t.query(api.cases.listDemos, {})],
			[
				"cases.setDemo",
				() => t.mutation(api.cases.setDemo, { caseId, isDemo: true }),
			],
			["cases.getForEdit", () => t.query(api.cases.getForEdit, { caseId })],
			["cases.listAll", () => t.query(api.cases.listAll, {})],
			["cases.create", () => t.mutation(api.cases.create, casePayloadArgs())],
			[
				"cases.update",
				() => t.mutation(api.cases.update, { caseId, ...casePayloadArgs() }),
			],
			["cases.deleteCase", () => t.mutation(api.cases.deleteCase, { caseId })],
			["admins.listAll", () => t.query(api.admins.listAll, {})],
			[
				"admins.create",
				() =>
					t.mutation(api.admins.create, {
						email: "x@y.z",
						role: "admin" as const,
					}),
			],
			[
				"admins.deleteWithCascade",
				() => t.mutation(api.admins.deleteWithCascade, { adminId }),
			],
			[
				"uploads.generateUploadUrls",
				() => t.mutation(api.uploads.generateUploadUrls, { count: 2 }),
			],
			[
				"uploads.discardUploads",
				() => t.mutation(api.uploads.discardUploads, { storageIds: [] }),
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
			["cases.getDemo", () => asStranger.query(api.cases.getDemo, { caseId })],
			["cases.listDemos", () => asStranger.query(api.cases.listDemos, {})],
			[
				"cases.setDemo",
				() => asStranger.mutation(api.cases.setDemo, { caseId, isDemo: true }),
			],
			["cases.listAll", () => asStranger.query(api.cases.listAll, {})],
			[
				"cases.create",
				() => asStranger.mutation(api.cases.create, casePayloadArgs()),
			],
			[
				"cases.deleteCase",
				() => asStranger.mutation(api.cases.deleteCase, { caseId }),
			],
			["admins.listAll", () => asStranger.query(api.admins.listAll, {})],
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
		expect(await t.query(api.admins.viewer, {})).toBeNull();

		const asStranger = await withStranger(t, "stranger@test.caselab.invalid");
		expect(await asStranger.query(api.admins.viewer, {})).toBeNull();
	});

	// Tests that an admin loses access as soon as their admins row is deleted.
	it("stops authorizing a signed-in admin once their admins row is deleted", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t, { role: "admin" });
		await expect(asUser.query(api.cases.listAll, {})).resolves.toEqual([]);

		await t.run((ctx) => ctx.db.delete(adminId));

		await expect(asUser.query(api.cases.listAll, {})).rejects.toThrow(
			"Your account is not authorized.",
		);
		expect(await asUser.query(api.admins.viewer, {})).toBeNull();
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
			outsider.asUser.query(api.cases.getForEdit, { caseId }),
		).rejects.toThrow("You do not have access to this case.");
		await expect(
			outsider.asUser.mutation(api.cases.update, {
				caseId,
				...casePayloadArgs(),
			}),
		).rejects.toThrow("You do not have access to this case.");
		await expect(
			outsider.asUser.mutation(api.cases.deleteCase, { caseId }),
		).rejects.toThrow("You do not have access to this case.");
		await expect(outsider.asUser.query(api.cases.listAll, {})).resolves.toEqual(
			[],
		);
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
						knownFacts: "The buyer will pay up to $4.2M.",
					}),
				],
			}),
		});

		await expect(
			outsider.asUser.query(api.cases.getForEdit, { caseId }),
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
			outsider.asUser.query(api.cases.getDemo, { caseId }),
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
			collaborator.asUser.query(api.cases.getForEdit, { caseId }),
		).resolves.toMatchObject({ _id: caseId });
		await expect(
			outsider.asUser.query(api.cases.getForEdit, { caseId }),
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

		await collaborator.asUser.mutation(api.cases.update, {
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
			regular.asUser.mutation(api.admins.create, {
				email: "me-again@test.caselab.invalid",
				role: "super",
			}),
		).rejects.toThrow("Only a super admin can do this.");
		await expect(
			regular.asUser.mutation(api.admins.deleteWithCascade, {
				adminId: victim.adminId,
			}),
		).rejects.toThrow("Only a super admin can do this.");

		const roster = await regular.asUser.query(api.admins.listAll, {});
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
			superAdmin.asUser.mutation(api.admins.deleteWithCascade, {
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
			superAdmin.asUser.query(api.cases.getForEdit, { caseId }),
		).resolves.toMatchObject({ _id: caseId });
		await expect(
			superAdmin.asUser.query(api.cases.listAll, {}),
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
		return await t.mutation(api.simulations.start, { accessCode });
	}

	// Tests that the student-facing functions work without any identity.
	it("start/get/getPersonaHistory/exportRun/sendMessage all work with no identity", async () => {
		const t = newTestConvex();
		const state = await startRun(t);
		expect(state.runId).toBeDefined();

		await expect(
			t.query(api.simulations.get, { runId: state.runId }),
		).resolves.toMatchObject({ runId: state.runId });
		await expect(
			t.query(api.simulations.getPersonaHistory, {
				runId: state.runId,
				personaId: "A",
			}),
		).resolves.toEqual({ messages: [], reply: null });
		await expect(
			t.query(api.simulations.exportRun, { runId: state.runId }),
		).resolves.toMatchObject({ case: { caseName: "Owned Case" } });
		await expect(
			t.mutation(api.turn.sendMessage, {
				runId: state.runId,
				personaId: "no-such-persona",
				message: "hi",
			}),
		).rejects.toThrow(/Persona not found/);
	});

	// Tests that one run's id can never read another run's transcript, contacts or export.
	it("one run's id never reads another run's transcript, contacts, or export", async () => {
		const t = newTestConvex();
		const a = await startRun(t, "alpha");
		const b = await startRun(t, "beta");

		await t.run((ctx) =>
			ctx.db.insert("runMessages", {
				runId: a.runId,
				personaId: "A",
				role: "user",
				content: "run A private message",
				status: "done",
			}),
		);

		const bHistory = await t.query(api.simulations.getPersonaHistory, {
			runId: b.runId,
			personaId: "A",
		});
		expect(bHistory.messages).toEqual([]);

		const bExport = await t.query(api.simulations.exportRun, {
			runId: b.runId,
		});
		expect(JSON.stringify(bExport)).not.toContain("run A private message");
	});
});

describe("the registered-function surface", () => {
	// Raw source of every non-test, non-generated module under convex/, keyed by path relative to convex/.
	const sources = Object.fromEntries(
		Object.entries(
			import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./_generated/**"], {
				query: "?raw",
				import: "default",
				eager: true,
			}) as Record<string, string>,
		).map(([path, source]) => [path.replace(/^(\.\.\/|\.\/)/, ""), source]),
	);

	// Files that hold plain logic and must never register a function (the admin wrapper builders are the one exception).
	const isLogicFile = (path: string) => /^(services|lib|models)\//.test(path);
	const BUILDER_FILE = "services/adminFunctions.ts";

	const ADMIN_WRAPPERS = new Set([
		"adminQuery",
		"adminMutation",
		"superAdminMutation",
	]);
	const PUBLIC_WRAPPERS = new Set(["query", "mutation", "action"]);
	// The only functions anyone can call without being an admin: the student flow and the sign-in check.
	const ANONYMOUS_SURFACE = [
		"admins.viewer",
		"simulations.exportRun",
		"simulations.get",
		"simulations.getPersonaHistory",
		"simulations.start",
		"turn.sendMessage",
	];

	// Lists every `export const name = wrapper(` in the top-level modules as module.name plus its wrapper.
	function registeredExports() {
		return Object.entries(sources)
			.filter(([path]) => !isLogicFile(path))
			.flatMap(([path, source]) =>
				[...source.matchAll(/export const (\w+) = (\w+)\(/g)].map(
					([, name, wrapper]) => ({
						qualified: `${path.replace(/\.ts$/, "")}.${name}`,
						wrapper: wrapper!,
					}),
				),
			);
	}

	// Tests that exactly the pinned functions are callable without being an admin.
	it("lets only the pinned student-flow and viewer functions be called anonymously", () => {
		const anonymous = registeredExports()
			.filter(({ wrapper }) => PUBLIC_WRAPPERS.has(wrapper))
			.map(({ qualified }) => qualified)
			.sort();
		expect(anonymous).toEqual(ANONYMOUS_SURFACE);
	});

	// Tests that every other registered function is an admin function or internal, and no unknown wrapper is used.
	it("gates every other registered function behind an admin wrapper or makes it internal", () => {
		const ungated = registeredExports()
			.filter(
				({ wrapper }) =>
					!PUBLIC_WRAPPERS.has(wrapper) &&
					!ADMIN_WRAPPERS.has(wrapper) &&
					!wrapper.startsWith("internal"),
			)
			.map(({ qualified, wrapper }) => `${qualified} (${wrapper})`);
		expect(ungated).toEqual([]);
	});

	// Tests that no function is registered in services, lib or models, so the public surface is always a top-level module.
	it("registers no functions in services, lib or models", () => {
		const offenders = Object.entries(sources)
			.filter(([path]) => isLogicFile(path) && path !== BUILDER_FILE)
			.filter(([, source]) =>
				/(?<![.\w])(query|mutation|action|httpAction|internalQuery|internalMutation|internalAction)\(/.test(
					source.replace(/\/\/.*$/gm, ""),
				),
			)
			.map(([path]) => path);
		expect(offenders).toEqual([]);
	});
});
