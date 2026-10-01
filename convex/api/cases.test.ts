import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newTestConvex, withAdmin, withStranger } from "../test.setup";
import {
	caseStructure,
	personaPayload,
	uniqueAccessCode,
} from "../testFactories";

type T = ReturnType<typeof newTestConvex>;

// Inserts a case owned by the given admin.
async function seedCase(t: T, ownerAdminId: Id<"admins">) {
	return await t.run((ctx) =>
		ctx.db.insert("cases", {
			name: "Demo Case",
			brief: "A brief.",
			accessCode: uniqueAccessCode(),
			ownerAdminId,
			structure: caseStructure(),
		}),
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("cases.getDemo", () => {
	// Tests that a deployment with no demo case configured returns null.
	it("returns null when DEMO_CASE_ID is not set", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		expect(await asUser.query(api.api.cases.getDemo, {})).toBeNull();
	});

	// Tests that any admin, not only the owner, can read the configured demo case.
	it("returns the configured case to an admin who does not own it", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const other = await withAdmin(t, { email: "other@test.caselab.invalid" });
		const caseId = await seedCase(t, owner.adminId);
		vi.stubEnv("DEMO_CASE_ID", caseId);
		const demo = await other.asUser.query(api.api.cases.getDemo, {});
		expect(demo?._id).toBe(caseId);
		expect(demo?.name).toBe("Demo Case");
	});

	// Tests that a demo id pointing at a deleted case returns null rather than failing.
	it("returns null when the configured case was deleted", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		const caseId = await seedCase(t, adminId);
		await t.run((ctx) => ctx.db.delete("cases", caseId));
		vi.stubEnv("DEMO_CASE_ID", caseId);
		expect(await asUser.query(api.api.cases.getDemo, {})).toBeNull();
	});

	// Tests that a malformed demo id returns null rather than failing.
	it("returns null when the configured id is not a valid case id", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		vi.stubEnv("DEMO_CASE_ID", "not-an-id");
		expect(await asUser.query(api.api.cases.getDemo, {})).toBeNull();
	});

	// Tests that someone who is not an admin cannot read the demo case.
	it("refuses a signed-in user who is not an admin", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t);
		vi.stubEnv("DEMO_CASE_ID", await seedCase(t, owner.adminId));
		const stranger = await withStranger(t);
		await expect(stranger.query(api.api.cases.getDemo, {})).rejects.toThrow(
			"Your account is not authorized.",
		);
	});
});

describe("cases.create", () => {
	// Tests that creating through the public API returns the new case id and makes the caller its owner.
	it("returns the new case id and records the caller as owner", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		const { caseId } = await asUser.mutation(api.api.cases.create, {
			name: "New Case",
			brief: "Brief",
			accessCode: uniqueAccessCode(),
			personas: [personaPayload("A")],
			referrals: [],
			roots: ["A"],
			collaboratorAdminIds: [],
		});
		const stored = await t.run((ctx) => ctx.db.get("cases", caseId));
		expect(stored?.ownerAdminId).toBe(adminId);
	});
});
