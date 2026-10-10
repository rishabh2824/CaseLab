import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { newTestConvex, withAdmin, withStranger } from "./test.setup";
import {
	caseStructure,
	personaPayload,
	uniqueAccessCode,
} from "./testFactories";

type T = ReturnType<typeof newTestConvex>;

// Inserts a case owned by the given admin, optionally flagged as a demo.
async function seedCase(
	t: T,
	ownerAdminId: Id<"admins">,
	overrides: { name?: string; isDemo?: boolean } = {},
) {
	return await t.run((ctx) =>
		ctx.db.insert("cases", {
			name: overrides.name ?? "Demo Case",
			brief: "A brief.",
			commonInformation: "",
			accessCode: uniqueAccessCode(),
			ownerAdminId,
			isDemo: overrides.isDemo ?? false,
			structure: caseStructure(),
		}),
	);
}

describe("cases.listDemos", () => {
	// Tests that only flagged cases are listed, sorted by name, with just an id and a name.
	it("lists only demo cases, sorted by name, without their access codes", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const other = await withAdmin(t, { email: "other@test.caselab.invalid" });
		const zed = await seedCase(t, owner.adminId, { name: "Zed", isDemo: true });
		const alpha = await seedCase(t, owner.adminId, {
			name: "Alpha",
			isDemo: true,
		});
		await seedCase(t, owner.adminId, { name: "Private" });

		const demos = await other.asUser.query(api.cases.listDemos, {});
		expect(demos).toEqual([
			{ _id: alpha, name: "Alpha" },
			{ _id: zed, name: "Zed" },
		]);
	});
});

describe("cases.getDemo", () => {
	// Tests that any admin can read a demo case, and that its access code and owner are withheld.
	it("returns a demo case to an admin who does not own it, without its access code or owner", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const other = await withAdmin(t, { email: "other@test.caselab.invalid" });
		const caseId = await seedCase(t, owner.adminId, { isDemo: true });

		const demo = await other.asUser.query(api.cases.getDemo, { caseId });
		expect(demo?._id).toBe(caseId);
		expect(demo?.name).toBe("Demo Case");
		expect(demo).not.toHaveProperty("accessCode");
		expect(demo).not.toHaveProperty("ownerAdminId");
	});

	// Tests that a case which is not flagged as a demo is not readable through getDemo.
	it("returns null for a case that is not a demo", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const other = await withAdmin(t, { email: "other@test.caselab.invalid" });
		const caseId = await seedCase(t, owner.adminId);
		expect(await other.asUser.query(api.cases.getDemo, { caseId })).toBeNull();
	});

	// Tests that a deleted case returns null rather than failing.
	it("returns null when the case was deleted", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		const caseId = await seedCase(t, adminId, { isDemo: true });
		await t.run((ctx) => ctx.db.delete("cases", caseId));
		expect(await asUser.query(api.cases.getDemo, { caseId })).toBeNull();
	});

	// Tests that a malformed id returns null rather than failing.
	it("returns null when the id is not a valid case id", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		expect(
			await asUser.query(api.cases.getDemo, { caseId: "not-an-id" }),
		).toBeNull();
	});

	// Tests that someone who is not an admin cannot read a demo case.
	it("refuses a signed-in user who is not an admin", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t);
		const caseId = await seedCase(t, owner.adminId, { isDemo: true });
		const stranger = await withStranger(t);
		await expect(stranger.query(api.cases.getDemo, { caseId })).rejects.toThrow(
			"Your account is not authorized.",
		);
	});
});

describe("cases.setDemo", () => {
	// Tests that a super admin can switch the demo flag on and off, and that listDemos follows.
	it("lets a super admin toggle a case on and off", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const boss = await withAdmin(t, {
			email: "boss@test.caselab.invalid",
			role: "super",
		});
		const caseId = await seedCase(t, owner.adminId);

		await boss.asUser.mutation(api.cases.setDemo, { caseId, isDemo: true });
		expect(await boss.asUser.query(api.cases.listDemos, {})).toEqual([
			{ _id: caseId, name: "Demo Case" },
		]);

		await boss.asUser.mutation(api.cases.setDemo, {
			caseId,
			isDemo: false,
		});
		expect(await boss.asUser.query(api.cases.listDemos, {})).toEqual([]);
	});

	// Tests that a regular admin, even the owner of the case, cannot change the flag.
	it("refuses a regular admin, even the owner of the case", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t);
		const caseId = await seedCase(t, owner.adminId);
		await expect(
			owner.asUser.mutation(api.cases.setDemo, { caseId, isDemo: true }),
		).rejects.toThrow("Only a super admin can do this.");
		const stored = await t.run((ctx) => ctx.db.get("cases", caseId));
		expect(stored?.isDemo).toBe(false);
	});

	// Tests that flagging a case that no longer exists fails clearly.
	it("fails for a case that does not exist", async () => {
		const t = newTestConvex();
		const boss = await withAdmin(t, { role: "super" });
		const caseId = await seedCase(t, boss.adminId);
		await t.run((ctx) => ctx.db.delete("cases", caseId));
		await expect(
			boss.asUser.mutation(api.cases.setDemo, { caseId, isDemo: true }),
		).rejects.toThrow("Case not found.");
	});
});

describe("cases.create", () => {
	// Tests that creating through the public API returns the new case id and makes the caller its owner.
	it("returns the new case id and records the caller as owner", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		const { caseId } = await asUser.mutation(api.cases.create, {
			name: "New Case",
			brief: "Brief",
			commonInformation: "",
			accessCode: uniqueAccessCode(),
			structure: {
				personas: [personaPayload("A")],
				referrals: [],
				roots: ["A"],
			},
			collaboratorAdminIds: [],
		});
		const stored = await t.run((ctx) => ctx.db.get("cases", caseId));
		expect(stored?.ownerAdminId).toBe(adminId);
		expect(stored?.isDemo).toBe(false);
	});
});

describe("cases.update", () => {
	// Tests that editing a demo case keeps it a demo.
	it("keeps the demo flag when a case is edited", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		const caseId = await seedCase(t, adminId, { isDemo: true });
		await asUser.mutation(api.cases.update, {
			caseId,
			name: "Renamed",
			brief: "Brief",
			commonInformation: "",
			accessCode: uniqueAccessCode(),
			structure: {
				personas: [personaPayload("A")],
				referrals: [],
				roots: ["A"],
			},
			collaboratorAdminIds: [],
		});
		const stored = await t.run((ctx) => ctx.db.get("cases", caseId));
		expect(stored?.name).toBe("Renamed");
		expect(stored?.isDemo).toBe(true);
	});
});

describe("cases.listAll", () => {
	// Tests that the list used by the edit page reports the demo flag of each case.
	it("reports whether each case is a demo", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		await seedCase(t, adminId, { name: "A", isDemo: true });
		await seedCase(t, adminId, { name: "B" });
		const list = await asUser.query(api.cases.listAll, {});
		expect(list.map((c) => [c.name, c.isDemo])).toEqual([
			["A", true],
			["B", false],
		]);
	});
});
