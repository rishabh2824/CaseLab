import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newTestConvex, withAdmin } from "../test.setup";

describe("requireCurrentAdmin / requireSuperAdmin (via api/admins.ts)", () => {
	it("rejects an unauthenticated caller", async () => {
		const t = newTestConvex();
		await expect(t.query(api.api.admins.listAll, {})).rejects.toThrow(
			"Not signed in.",
		);
	});

	it("rejects a signed-in Google user with no matching admins row", async () => {
		const t = newTestConvex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", { email: "stranger@test.caselab.invalid" }),
		);
		await expect(
			t.withIdentity({ subject: userId }).query(api.api.admins.listAll, {}),
		).rejects.toThrow("Your account is not authorized.");
	});

	it("allows any signed-in admin to list the roster", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "admin" });
		await withAdmin(t, { email: "b@test.caselab.invalid", role: "admin" });
		const admins = await asUser.query(api.api.admins.listAll, {});
		expect(admins).toHaveLength(2);
	});

	it("rejects a non-super admin creating another admin", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "admin" });
		await expect(
			asUser.mutation(api.api.admins.create, {
				email: "new@test.caselab.invalid",
				role: "admin",
			}),
		).rejects.toThrow("Only a super admin can do this.");
	});

	it("allows a super admin to create another admin", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const created = await asUser.mutation(api.api.admins.create, {
			email: "new@test.caselab.invalid",
			role: "admin",
		});
		expect(created.email).toBe("new@test.caselab.invalid");
	});

	it("rejects creating a duplicate email", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		await withAdmin(t, { email: "dup@test.caselab.invalid" });
		await expect(
			asUser.mutation(api.api.admins.create, {
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
				name: "Case",
				brief: "Brief",
				ownerAdminId: ownerAdminId as Id<"admins">,
				structure: { personas: [], referrals: [], roots: [] },
			}),
		);
	}

	it("refuses to delete a super admin", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const { adminId: otherSuperId } = await withAdmin(t, {
			role: "super",
			email: "s2@test.caselab.invalid",
		});
		await expect(
			asUser.mutation(api.api.admins.deleteWithCascade, {
				adminId: otherSuperId,
			}),
		).rejects.toThrow("Super admins cannot be deleted.");
	});

	it("deletes an owned case with no collaborators", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t, { role: "super" });
		const { adminId: ownerId } = await withAdmin(t, {
			email: "owner@test.caselab.invalid",
		});
		const caseId = await seedCase(t, ownerId);

		const result = await asUser.mutation(api.api.admins.deleteWithCascade, {
			adminId: ownerId,
		});
		expect(result).toEqual({ ok: true, casesDeleted: 1, casesReassigned: 0 });
		expect(await t.run((ctx) => ctx.db.get(caseId))).toBeNull();
	});

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
			ctx.db.insert("collaborators", { caseId, adminId: collabId, addedAt: 1 }),
		);

		const result = await asUser.mutation(api.api.admins.deleteWithCascade, {
			adminId: ownerId,
		});
		expect(result).toEqual({ ok: true, casesDeleted: 0, casesReassigned: 1 });

		const updatedCase = await t.run((ctx) => ctx.db.get(caseId));
		expect(updatedCase?.ownerAdminId).toBe(collabId);
		const remainingCollaborators = await t.run((ctx) =>
			ctx.db
				.query("collaborators")
				.withIndex("by_case", (q) => q.eq("caseId", caseId))
				.collect(),
		);
		expect(remainingCollaborators).toHaveLength(0);
	});

	// Deleting an admin cascade-deletes their owned cases even if one has a live run -- the
	// admin is assumed to know the consequences (schema.ts's comment on `runs`); the old guard
	// here was an availability hole (an unauthenticated access-code holder could keep an admin
	// permanently undeletable) for a scenario that's rare in practice.
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
				startTime: 0,
				expiresAt: Date.now() + 1_000_000,
				activePersonaKey: "A",
				unlockedReferredIds: [],
				unlockedAt: {},
				sharedFiles: [],
				personaChatState: {},
			}),
		);

		const result = await asUser.mutation(api.api.admins.deleteWithCascade, {
			adminId: ownerId,
		});
		expect(result).toEqual({ ok: true, casesDeleted: 1, casesReassigned: 0 });
		expect(await t.run((ctx) => ctx.db.get(liveCaseId))).toBeNull();
	});
});
