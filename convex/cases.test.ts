import { describe, expect, it } from "vitest";
import {
	caseStructure,
	personaPayload,
	uniqueAccessCode,
} from "../tests/support/factories";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { newTestConvex, withAdmin, withStranger } from "./test.setup";

type T = ReturnType<typeof newTestConvex>;

// Inserts a case owned by the given admin, optionally flagged as a template.
async function seedCase(
	t: T,
	ownerAdminId: Id<"admins">,
	overrides: { name?: string; isTemplate?: boolean } = {},
) {
	return await t.run((ctx) =>
		ctx.db.insert("cases", {
			name: overrides.name ?? "Template Case",
			brief: "A brief.",
			commonInformation: "",
			accessCode: uniqueAccessCode(),
			ownerAdminId,
			isTemplate: overrides.isTemplate ?? false,
			structure: caseStructure(),
		}),
	);
}

describe("cases.listTemplates", () => {
	// Tests that a regular admin sees their own cases plus every flagged template, once each, sorted, with just an id and a name.
	it("lists the caller's own cases and all templates, sorted, without access codes", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const other = await withAdmin(t, { email: "other@test.caselab.invalid" });
		const zed = await seedCase(t, owner.adminId, {
			name: "Zed",
			isTemplate: true,
		});
		const alpha = await seedCase(t, other.adminId, {
			name: "Alpha",
			isTemplate: true,
		});
		const mine = await seedCase(t, other.adminId, { name: "Mine" });
		await seedCase(t, owner.adminId, { name: "Private" });

		const choices = await other.asUser.query(api.cases.listTemplates, {});
		expect(choices).toEqual([
			{ _id: alpha, name: "Alpha" },
			{ _id: mine, name: "Mine" },
			{ _id: zed, name: "Zed" },
		]);
	});
});

describe("cases.getTemplate", () => {
	// Tests that any admin can load a template, and that its access code and owner are withheld.
	it("returns a template to an admin who does not own it, without its access code or owner", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const other = await withAdmin(t, { email: "other@test.caselab.invalid" });
		const caseId = await seedCase(t, owner.adminId, { isTemplate: true });

		const template = await other.asUser.query(api.cases.getTemplate, {
			caseId,
		});
		expect(template._id).toBe(caseId);
		expect(template.name).toBe("Template Case");
		expect(template).not.toHaveProperty("accessCode");
		expect(template).not.toHaveProperty("ownerAdminId");
	});

	// Tests that a case the caller can edit loads without being flagged.
	it("returns a case the caller owns even when it is not a template", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		const caseId = await seedCase(t, adminId);
		const template = await asUser.query(api.cases.getTemplate, { caseId });
		expect(template._id).toBe(caseId);
	});

	// Tests that another admin's unflagged case stays private.
	it("refuses a case that is neither a template nor the caller's", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const other = await withAdmin(t, { email: "other@test.caselab.invalid" });
		const caseId = await seedCase(t, owner.adminId);
		await expect(
			other.asUser.query(api.cases.getTemplate, { caseId }),
		).rejects.toThrow("You do not have access to this case.");
	});

	// Tests that a deleted case fails clearly.
	it("fails when the case was deleted", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		const caseId = await seedCase(t, adminId, { isTemplate: true });
		await t.run((ctx) => ctx.db.delete("cases", caseId));
		await expect(
			asUser.query(api.cases.getTemplate, { caseId }),
		).rejects.toThrow("Case not found.");
	});

	// Tests that someone who is not an admin cannot load a template.
	it("refuses a signed-in user who is not an admin", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t);
		const caseId = await seedCase(t, owner.adminId, { isTemplate: true });
		const stranger = await withStranger(t);
		await expect(
			stranger.query(api.cases.getTemplate, { caseId }),
		).rejects.toThrow("Your account is not authorized.");
	});
});

describe("cases.setTemplate", () => {
	// Tests that a super admin can switch the template flag on and off, and that listTemplates follows.
	it("lets a super admin toggle a case on and off", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t, { email: "owner@test.caselab.invalid" });
		const other = await withAdmin(t, { email: "other@test.caselab.invalid" });
		const boss = await withAdmin(t, {
			email: "boss@test.caselab.invalid",
			role: "super",
		});
		const caseId = await seedCase(t, owner.adminId);

		await boss.asUser.mutation(api.cases.setTemplate, {
			caseId,
			isTemplate: true,
		});
		expect(await other.asUser.query(api.cases.listTemplates, {})).toEqual([
			{ _id: caseId, name: "Template Case" },
		]);

		await boss.asUser.mutation(api.cases.setTemplate, {
			caseId,
			isTemplate: false,
		});
		expect(await other.asUser.query(api.cases.listTemplates, {})).toEqual([]);
	});

	// Tests that a regular admin, even the owner of the case, cannot change the flag.
	it("refuses a regular admin, even the owner of the case", async () => {
		const t = newTestConvex();
		const owner = await withAdmin(t);
		const caseId = await seedCase(t, owner.adminId);
		await expect(
			owner.asUser.mutation(api.cases.setTemplate, {
				caseId,
				isTemplate: true,
			}),
		).rejects.toThrow("Only a super admin can do this.");
		const stored = await t.run((ctx) => ctx.db.get("cases", caseId));
		expect(stored?.isTemplate).toBe(false);
	});

	// Tests that flagging a case that no longer exists fails clearly.
	it("fails for a case that does not exist", async () => {
		const t = newTestConvex();
		const boss = await withAdmin(t, { role: "super" });
		const caseId = await seedCase(t, boss.adminId);
		await t.run((ctx) => ctx.db.delete("cases", caseId));
		await expect(
			boss.asUser.mutation(api.cases.setTemplate, {
				caseId,
				isTemplate: true,
			}),
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
		expect(stored?.isTemplate).toBe(false);
	});
});

describe("cases.update", () => {
	// Tests that editing a template keeps it a template.
	it("keeps the template flag when a case is edited", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		const caseId = await seedCase(t, adminId, { isTemplate: true });
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
		expect(stored?.isTemplate).toBe(true);
	});
});

describe("cases.listAll", () => {
	// Tests that the list used by the edit page reports the template flag of each case.
	it("reports whether each case is a template", async () => {
		const t = newTestConvex();
		const { asUser, adminId } = await withAdmin(t);
		await seedCase(t, adminId, { name: "A", isTemplate: true });
		await seedCase(t, adminId, { name: "B" });
		const list = await asUser.query(api.cases.listAll, {});
		expect(list.map((c) => [c.name, c.isTemplate])).toEqual([
			["A", true],
			["B", false],
		]);
	});
});
