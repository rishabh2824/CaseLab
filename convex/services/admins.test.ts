import { describe, expect, it } from "vitest";
import { api, components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newTestConvex, withAdmin, withStranger } from "../test.setup";

describe("requireCurrentAdmin / requireSuperAdmin (via api/admins.ts)", () => {
	// Tests that an unauthenticated caller is rejected.
	it("rejects an unauthenticated caller", async () => {
		const t = newTestConvex();
		await expect(t.query(api.admins.listAll, {})).rejects.toThrow(
			"Not signed in.",
		);
	});

	// Tests that a signed-in Google user with no matching admins row is rejected.
	it("rejects a signed-in Google user with no matching admins row", async () => {
		const t = newTestConvex();
		const asStranger = await withStranger(t, "stranger@test.caselab.invalid");
		await expect(asStranger.query(api.admins.listAll, {})).rejects.toThrow(
			"Your account is not authorized.",
		);
	});

	// Tests that any signed-in admin can list the roster.
	it("allows any signed-in admin to list the roster", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "admin" });
		await withAdmin(t, { email: "b@test.caselab.invalid", role: "admin" });
		const admins = await asUser.query(api.admins.listAll, {});
		expect(admins).toHaveLength(2);
	});

	// Tests that a non-super admin cannot create another admin.
	it("rejects a non-super admin creating another admin", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "admin" });
		await expect(
			asUser.mutation(api.admins.create, {
				email: "new@test.caselab.invalid",
				role: "admin",
			}),
		).rejects.toThrow("Only a super admin can do this.");
	});

	// Tests that a super admin can create another admin.
	it("allows a super admin to create another admin", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const created = await asUser.mutation(api.admins.create, {
			email: "new@test.caselab.invalid",
			role: "admin",
		});
		expect(created.email).toBe("new@test.caselab.invalid");
	});

	// Tests that creating an admin with a duplicate email is rejected.
	it("rejects creating a duplicate email", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		await withAdmin(t, { email: "dup@test.caselab.invalid" });
		await expect(
			asUser.mutation(api.admins.create, {
				email: "dup@test.caselab.invalid",
				role: "admin",
			}),
		).rejects.toThrow("An admin with this email already exists.");
	});
});

describe("deleteAdminWithCascade (via api/admins.ts:deleteWithCascade)", () => {
	async function seedCase(
		t: ReturnType<typeof newTestConvex>,
		ownerAdminId: string,
	) {
		return await t.run((ctx) =>
			ctx.db.insert("cases", {
				commonInformation: "",
				isDemo: false,
				name: "Case",
				brief: "Brief",
				accessCode: "seedcode",
				ownerAdminId: ownerAdminId as Id<"admins">,
				structure: { personas: [], referrals: [], roots: [] },
			}),
		);
	}

	// Tests that deleting a super admin is refused.
	it("refuses to delete a super admin", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const { adminId: otherSuperId } = await withAdmin(t, {
			role: "super",
			email: "s2@test.caselab.invalid",
		});
		await expect(
			asUser.mutation(api.admins.deleteWithCascade, {
				adminId: otherSuperId,
			}),
		).rejects.toThrow("Super admins cannot be deleted.");
	});

	// Tests that deleting an admin removes their owned cases that have no collaborators.
	it("deletes an owned case with no collaborators", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const { adminId: ownerId } = await withAdmin(t, {
			email: "owner@test.caselab.invalid",
		});
		const caseId = await seedCase(t, ownerId);

		const result = await asUser.mutation(api.admins.deleteWithCascade, {
			adminId: ownerId,
		});
		expect(result).toEqual({ casesDeleted: 1, casesReassigned: 0 });
		expect(await t.run((ctx) => ctx.db.get(caseId))).toBeNull();
	});

	// Tests that deleting an admin promotes the longest-standing collaborator instead of deleting a shared case.
	it("promotes the longest-standing collaborator instead of deleting a shared case", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const { adminId: ownerId } = await withAdmin(t, {
			email: "owner@test.caselab.invalid",
		});
		const { adminId: collabId } = await withAdmin(t, {
			email: "collab@test.caselab.invalid",
		});
		const caseId = await seedCase(t, ownerId);
		await t.run((ctx) =>
			ctx.db.insert("collaborators", { caseId, adminId: collabId }),
		);

		const result = await asUser.mutation(api.admins.deleteWithCascade, {
			adminId: ownerId,
		});
		expect(result).toEqual({ casesDeleted: 0, casesReassigned: 1 });

		const updatedCase = await t.run((ctx) => ctx.db.get(caseId));
		expect(updatedCase?.ownerAdminId).toBe(collabId);
		const remainingCollaborators = await t.run((ctx) =>
			ctx.db
				.query("collaborators")
				.withIndex("by_case_and_admin", (q) => q.eq("caseId", caseId))
				.collect(),
		);
		expect(remainingCollaborators).toHaveLength(0);
	});

	// Tests that deleting an admin cascades through a case with a live run instead of refusing.
	it("cascades through a case with a live run instead of refusing the whole operation", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const { adminId: ownerId } = await withAdmin(t, {
			email: "owner@test.caselab.invalid",
		});
		const liveCaseId = await seedCase(t, ownerId);
		await t.run((ctx) =>
			ctx.db.insert("runs", {
				caseId: liveCaseId,
				expiresAt: Date.now() + 1_000_000,
				unlockedAt: {},
				sharedFiles: [],
				personaChatState: {},
			}),
		);

		const result = await asUser.mutation(api.admins.deleteWithCascade, {
			adminId: ownerId,
		});
		expect(result).toEqual({ casesDeleted: 1, casesReassigned: 0 });
		expect(await t.run((ctx) => ctx.db.get(liveCaseId))).toBeNull();
	});

	// Tests that deleting an admin removes their Better Auth user, sessions and accounts.
	it("removes the deleted admin's Better Auth user, sessions and accounts", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const { adminId: ownerId, email } = await withAdmin(t, {
			email: "owner@test.caselab.invalid",
		});
		const findUser = () =>
			t.run((ctx) =>
				ctx.runQuery(components.betterAuth.adapter.findMany, {
					model: "user",
					where: [{ field: "email", value: email }],
					paginationOpts: { numItems: 1, cursor: null },
				}),
			);
		const user = (await findUser()).page[0];
		expect(user).toBeTruthy();

		await asUser.mutation(api.admins.deleteWithCascade, {
			adminId: ownerId,
		});

		expect((await findUser()).page).toHaveLength(0);
		for (const model of ["session", "account"] as const) {
			const rows = await t.run((ctx) =>
				ctx.runQuery(components.betterAuth.adapter.findMany, {
					model,
					where: [{ field: "userId", value: user._id }],
					paginationOpts: { numItems: 10, cursor: null },
				}),
			);
			expect(rows.page).toHaveLength(0);
		}
	});
});
