import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { CaseStructure } from "../models/cases";
import { newTestConvex } from "../test.setup";
import {
	personaPayload,
	referralEdge,
	uniqueAccessCode,
} from "../testFactories";
import {
	type CasePayload,
	createCase,
	deleteCase,
	listCases,
	requireCaseAccess,
	updateCase,
	validateGraph,
} from "./cases";

// Builds a valid case payload with a unique access code and optional overrides.
function payload(
	overrides: Partial<Omit<CasePayload, "structure">> &
		Partial<CaseStructure> = {},
): CasePayload {
	const {
		personas = [personaPayload("A")],
		referrals = [],
		roots = ["A"],
		...rest
	} = overrides;
	return {
		name: "Sterling Industries",
		brief: "Reduce office supply costs.",
		commonInformation: "",
		accessCode: uniqueAccessCode(),
		collaboratorAdminIds: [],
		...rest,
		structure: { personas, referrals, roots },
	};
}

describe("validateGraph (pure)", () => {
	// Tests that a persona referred by two different parents is accepted.
	it("accepts a persona referred by two different parents", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A"), personaPayload("B"), personaPayload("C")],
				[referralEdge("A", "C"), referralEdge("B", "C")],
				["A", "B"],
			),
		).not.toThrow();
	});

	// Tests that a cyclic referral graph is rejected.
	it("rejects a cyclic referral graph", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A"), personaPayload("B")],
				[referralEdge("A", "B"), referralEdge("B", "A")],
				["A"],
			),
		).toThrow(/cycle/i);
	});

	// Tests that a referral pointing at a nonexistent persona is rejected.
	it("rejects a referral pointing at a nonexistent persona", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A")],
				[referralEdge("A", "does-not-exist")],
				["A"],
			),
		).toThrow(/Unknown referral toId/);
	});

	// Tests that a root pointing at a nonexistent persona is rejected.
	it("rejects a root pointing at a nonexistent persona", () => {
		expect(() =>
			validateGraph([personaPayload("A")], [], ["A", "does-not-exist"]),
		).toThrow(/Unknown root persona id/);
	});

	// Tests that duplicate persona ids are rejected.
	it("rejects duplicate persona ids", () => {
		expect(() =>
			validateGraph([personaPayload("A"), personaPayload("A")], [], ["A"]),
		).toThrow(/Duplicate persona/);
	});

	// Tests that a duplicate (fromId, toId) referral pair is rejected.
	it("rejects a duplicate (fromId, toId) referral pair", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A"), personaPayload("B")],
				[referralEdge("A", "B"), referralEdge("A", "B")],
				["A"],
			),
		).toThrow(/Duplicate referral/);
	});

	// Tests that a duplicate root persona id is rejected.
	it("rejects a duplicate root persona id", () => {
		expect(() => validateGraph([personaPayload("A")], [], ["A", "A"])).toThrow(
			/Duplicate root/,
		);
	});

	// Tests that a persona with a blank name is rejected.
	it("rejects a persona with a blank name", () => {
		expect(() =>
			validateGraph([personaPayload("A", { name: "  " })], [], ["A"]),
		).toThrow(/Persona A: Name is required/);
	});

	// Tests that a persona with a blank role is rejected.
	it("rejects a persona with a blank role", () => {
		expect(() =>
			validateGraph([personaPayload("A", { role: "" })], [], ["A"]),
		).toThrow(/Persona A: Role is required/);
	});

	// Tests that zero, negative and fractional persona availability values are rejected.
	it.each([0, -5, 2.5])(
		"rejects a persona availability of %s minutes",
		(availabilityMinutes) => {
			expect(() =>
				validateGraph(
					[personaPayload("A", { availabilityMinutes })],
					[],
					["A"],
				),
			).toThrow(/Persona A: Must be a whole number of minutes/);
		},
	);

	// Tests that a persona with no availability set is accepted.
	it("accepts a persona with no availability set at all", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A", { availabilityMinutes: null })],
				[],
				["A"],
			),
		).not.toThrow();
	});

	// Tests that a persona id with characters unsafe for an HTML attribute is rejected.
	it("rejects a persona id containing characters unsafe for an HTML attribute", () => {
		const dangerousId = `"><script>alert(1)</script>`;
		expect(() =>
			validateGraph([personaPayload(dangerousId)], [], [dangerousId]),
		).toThrow(/Invalid persona id/);
	});

	// Tests that a persona id of only letters, digits, hyphens and underscores is accepted.
	it("accepts a persona id made only of letters, digits, hyphens, and underscores", () => {
		expect(() =>
			validateGraph(
				[personaPayload("00000000-0000-4000-8000-000000000001")],
				[],
				["00000000-0000-4000-8000-000000000001"],
			),
		).not.toThrow();
	});
});

// Inserts an admin with the given role and returns the document.
async function makeAdmin(
	t: ReturnType<typeof newTestConvex>,
	role: "super" | "admin" = "admin",
): Promise<Doc<"admins">> {
	const id = await t.run((ctx) =>
		ctx.db.insert("admins", {
			email: `${role}-${Math.random().toString(36).slice(2)}@test.caselab.invalid`,
			role,
		}),
	);
	return (await t.run((ctx) => ctx.db.get(id)))!;
}

describe("case access control", () => {
	// Tests that the owner can read, update and delete their own case.
	it("lets the owner read, update, and delete their own case", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) => createCase(ctx, payload(), owner));
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		await expect(
			t.run((ctx) => requireCaseAccess(ctx, c, owner)),
		).resolves.toBeNull();
		await expect(
			t.run((ctx) =>
				updateCase(ctx, caseId, payload({ name: "Renamed" }), owner),
			),
		).resolves.toBeNull();
	});

	// Tests that a non-owner, non-collaborator is denied every action.
	it("denies a non-owner, non-collaborator every action", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const stranger = await makeAdmin(t);
		const caseId = await t.run((ctx) => createCase(ctx, payload(), owner));
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;

		await expect(
			t.run((ctx) => requireCaseAccess(ctx, c, stranger)),
		).rejects.toThrow("You do not have access");
		await expect(
			t.run((ctx) => updateCase(ctx, caseId, payload(), stranger)),
		).rejects.toThrow("You do not have access");
	});

	// Tests that a collaborator has full access, including editing the collaborator list.
	it("gives a collaborator full access, including changing the collaborator list itself", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const collaborator = await makeAdmin(t);
		const third = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({ collaboratorAdminIds: [collaborator._id] }),
				owner,
			),
		);

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({ collaboratorAdminIds: [third._id] }),
				collaborator,
			),
		);

		const cAfter = (await t.run((ctx) => ctx.db.get(caseId)))!;
		await expect(
			t.run((ctx) => requireCaseAccess(ctx, cAfter, collaborator)),
		).rejects.toThrow();
		await expect(
			t.run((ctx) => requireCaseAccess(ctx, cAfter, third)),
		).resolves.toBeNull();
	});

	// Tests that a super admin bypasses ownership entirely.
	it("lets a super admin bypass ownership entirely", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const superAdmin = await makeAdmin(t, "super");
		const caseId = await t.run((ctx) => createCase(ctx, payload(), owner));
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		await expect(
			t.run((ctx) => requireCaseAccess(ctx, c, superAdmin)),
		).resolves.toBeNull();
	});

	// Tests that a regular admin's case list includes owned and collaborator cases but not unrelated ones.
	it("lists owned and collaborator cases for a regular admin, excluding unrelated cases", async () => {
		const t = newTestConvex();
		const a = await makeAdmin(t);
		const b = await makeAdmin(t);
		await t.run((ctx) => createCase(ctx, payload({ name: "Owned by A" }), a));
		const sharedId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({ name: "Shared with B", collaboratorAdminIds: [b._id] }),
				a,
			),
		);
		await t.run((ctx) => createCase(ctx, payload({ name: "Unrelated" }), a));

		const listing = await t.run((ctx) => listCases(ctx, b));
		const ids = new Set(listing.map((c) => c._id));
		expect(ids.has(sharedId)).toBe(true);
		expect(listing).toHaveLength(1);
	});

	// Tests that a super admin's case list includes every case.
	it("lists every case for a super admin", async () => {
		const t = newTestConvex();
		const a = await makeAdmin(t);
		const superAdmin = await makeAdmin(t, "super");
		const caseId = await t.run((ctx) =>
			createCase(ctx, payload({ name: "Owned by A" }), a),
		);

		const listing = await t.run((ctx) => listCases(ctx, superAdmin));
		expect(listing.map((c) => c._id)).toContain(caseId);
	});
});

describe("replaceCollaborators addedAt (via updateCase)", () => {
	// Tests that an existing collaborator's addedAt is preserved across an unrelated save.
	it("preserves an existing collaborator's addedAt across an unrelated save", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const collaborator = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({ collaboratorAdminIds: [collaborator._id] }),
				owner,
			),
		);
		const rowBefore = await t.run((ctx) =>
			ctx.db
				.query("collaborators")
				.withIndex("by_case_and_admin", (q) => q.eq("caseId", caseId))
				.first(),
		);

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({
					collaboratorAdminIds: [collaborator._id],
					name: "Renamed",
				}),
				owner,
			),
		);
		const rowAfter = await t.run((ctx) =>
			ctx.db
				.query("collaborators")
				.withIndex("by_case_and_admin", (q) => q.eq("caseId", caseId))
				.first(),
		);

		expect(rowAfter?._id).toBe(rowBefore?._id);
		expect(rowAfter?._creationTime).toBe(rowBefore?._creationTime);
	});

	// Tests that saving inserts a row only for a newly added collaborator.
	it("inserts a row only for a newly added collaborator, leaving existing ones alone", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const original = await makeAdmin(t);
		const added = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(ctx, payload({ collaboratorAdminIds: [original._id] }), owner),
		);
		const originalRowBefore = await t.run((ctx) =>
			ctx.db
				.query("collaborators")
				.withIndex("by_case_and_admin", (q) => q.eq("caseId", caseId))
				.first(),
		);

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({ collaboratorAdminIds: [original._id, added._id] }),
				owner,
			),
		);

		const rows = await t.run((ctx) =>
			ctx.db
				.query("collaborators")
				.withIndex("by_case_and_admin", (q) => q.eq("caseId", caseId))
				.collect(),
		);
		expect(rows).toHaveLength(2);
		const originalRowAfter = rows.find((row) => row.adminId === original._id);
		expect(originalRowAfter?._id).toBe(originalRowBefore?._id);
		expect(originalRowAfter?._creationTime).toBe(
			originalRowBefore?._creationTime,
		);
	});
});

describe("collaborator validation (via createCase)", () => {
	// Tests that the owner appearing in their own collaborator list is rejected.
	it("rejects the owner appearing in their own collaborator list", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) =>
				createCase(ctx, payload({ collaboratorAdminIds: [owner._id] }), owner),
			),
		).rejects.toThrow(
			"The case owner cannot also be listed as a collaborator.",
		);
	});

	// Tests that an unknown admin id in the collaborator list is rejected.
	it("rejects an unknown admin id", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const bogusId = "999999999admins" as Id<"admins">;
		await expect(
			t.run((ctx) =>
				createCase(ctx, payload({ collaboratorAdminIds: [bogusId] }), owner),
			),
		).rejects.toThrow(/Unknown admin id/);
	});

	// Tests that a super admin in the collaborator list is rejected.
	it("rejects a super admin as a collaborator", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const superAdmin = await makeAdmin(t, "super");
		await expect(
			t.run((ctx) =>
				createCase(
					ctx,
					payload({ collaboratorAdminIds: [superAdmin._id] }),
					owner,
				),
			),
		).rejects.toThrow("Super admins cannot be added as collaborators.");
	});
});

describe("required fields (via createCase)", () => {
	// Tests that a blank case name is rejected.
	it("rejects a blank name", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ name: "   " }), owner)),
		).rejects.toThrow("Case name is required.");
	});

	// Tests that a blank case brief is rejected.
	it("rejects a blank brief", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ brief: "" }), owner)),
		).rejects.toThrow("Initial brief is required.");
	});

	// Tests that a name and brief are trimmed before being stored.
	it("trims a name/brief with surrounding whitespace before storing it", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({ name: "  Sterling Industries  ", brief: "  Do it.  " }),
				owner,
			),
		);
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		expect(c.name).toBe("Sterling Industries");
		expect(c.brief).toBe("Do it.");
	});

	// Tests that common information and every persona's name and role are trimmed before being stored.
	it("trims common information and every persona's name/role before storing them", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					commonInformation: "  Shared context.  ",
					personas: [
						personaPayload("A", { name: "  Mary  ", role: "  CFO  " }),
					],
				}),
				owner,
			),
		);
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		expect(c.commonInformation).toBe("Shared context.");
		const structure = c.structure as {
			personas: { name: string; role: string }[];
		};
		expect(structure.personas[0]).toMatchObject({ name: "Mary", role: "CFO" });
	});

	// Tests that an empty common information is stored as an empty string.
	it("stores empty common information as an empty string", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) => createCase(ctx, payload(), owner));
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		expect(c.commonInformation).toBe("");
	});
});

describe("access code validation", () => {
	// Tests that an access code with anything other than lowercase letters is rejected.
	it("rejects a code with anything other than lowercase letters", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) =>
				createCase(ctx, payload({ accessCode: "Sterling1" }), owner),
			),
		).rejects.toThrow("Access code must contain only lowercase letters.");
	});

	// Tests that a blank or whitespace-only access code is rejected.
	it("rejects a blank or whitespace-only access code -- every case needs a real one", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ accessCode: "   " }), owner)),
		).rejects.toThrow("Access code is required.");
	});

	// Tests that a duplicate access code on a second case is rejected.
	it("rejects a duplicate access code on a second case", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await t.run((ctx) =>
			createCase(ctx, payload({ accessCode: "sterling" }), owner),
		);
		await expect(
			t.run((ctx) =>
				createCase(ctx, payload({ accessCode: "sterling" }), owner),
			),
		).rejects.toThrow(
			"An access code with this value already exists on another case.",
		);
	});

	// Tests that a case can keep its own access code on update without conflicting with itself.
	it("lets a case keep its own access code on update without self-conflicting", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(ctx, payload({ accessCode: "sterling" }), owner),
		);
		await expect(
			t.run((ctx) =>
				updateCase(
					ctx,
					caseId,
					payload({ accessCode: "sterling", name: "Renamed" }),
					owner,
				),
			),
		).resolves.toBeNull();
	});
});

describe("persona graph persistence", () => {
	// Tests that a persona referred by two parents round-trips through save and load.
	it("round-trips a persona referred by two parents", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [
						personaPayload("A", { name: "Mary" }),
						personaPayload("B", { name: "John" }),
						personaPayload("C", { name: "Shared CFO" }),
					],
					referrals: [referralEdge("A", "C"), referralEdge("B", "C")],
					roots: ["A", "B"],
				}),
				owner,
			),
		);
		const c = (await t.run((ctx) => ctx.db.get(caseId)))! as Doc<"cases">;
		const structure = c.structure as {
			referrals: { fromId: string; toId: string }[];
			roots: string[];
		};
		expect(
			new Set(structure.referrals.map((r) => `${r.fromId}->${r.toId}`)),
		).toEqual(new Set(["A->C", "B->C"]));
		expect(new Set(structure.roots)).toEqual(new Set(["A", "B"]));
	});

	// Tests that a client-supplied persona id stays stable across create and update.
	it("keeps a client-supplied persona id stable across create then update, instead of regenerating it", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({ personas: [personaPayload("A")], roots: ["A"] }),
				owner,
			),
		);

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({
					personas: [personaPayload("A", { name: "Renamed" })],
					roots: ["A"],
				}),
				owner,
			),
		);

		const c = (await t.run((ctx) => ctx.db.get(caseId)))! as Doc<"cases">;
		const structure = c.structure as {
			personas: { id: string; name: string }[];
		};
		expect(structure.personas.map((p) => p.id)).toEqual(["A"]);
		expect(structure.personas[0]!.name).toBe("Renamed");
	});
});

describe("file links (via buildStructure/createCase)", () => {
	// Tests that two personas sharing a storage id are linked to the case once.
	it("links two personas sharing a storage id to the case once", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["shared"])),
		);
		const _caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [
						personaPayload("A", {
							profilePhoto: {
								storageId: storageId,
								fileName: "shared.pdf",
								contentType: "application/pdf",
							},
						}),
						personaPayload("B", {
							profilePhoto: {
								storageId: storageId,
								fileName: "shared.pdf",
								contentType: "application/pdf",
							},
						}),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);

		const rows = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});

	// Tests that the same storage id reappearing on update is still linked once.
	it("keeps a single link when the same storage id resurfaces on update", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["shared"])),
		);
		const photo = {
			storageId: storageId,
			fileName: "shared.pdf",
			contentType: "application/pdf",
		};
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [personaPayload("A", { profilePhoto: photo })],
					roots: ["A"],
				}),
				owner,
			),
		);

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({
					personas: [
						personaPayload("A", { profilePhoto: photo }),
						personaPayload("B", { profilePhoto: photo }),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);

		const rows = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});
});

describe("a storage id with no backing object", () => {
	// Tests that a photo reference to a nonexistent storage id is dropped while the rest of the case saves.
	it("drops a photo ref whose storage id doesn't exist, saving the rest of the case fine", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const ghostStorageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["gone"])),
		);
		await t.run((ctx) => ctx.storage.delete(ghostStorageId));

		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [
						personaPayload("A", {
							profilePhoto: {
								storageId: ghostStorageId,
								fileName: "gone.pdf",
								contentType: "application/pdf",
							},
						}),
					],
					roots: ["A"],
				}),
				owner,
			),
		);

		const c = (await t.run((ctx) => ctx.db.get(caseId)))! as Doc<"cases">;
		const structure = c.structure as {
			personas: { profilePhoto: unknown }[];
		};
		expect(structure.personas[0]?.profilePhoto).toBeNull();
		const rows = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_storage_id", (q) => q.eq("storageId", ghostStorageId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
	});
});

describe("file lifecycle (caseFiles reconciliation + orphan cleanup)", () => {
	async function makePhoto(t: ReturnType<typeof newTestConvex>) {
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
		return {
			storageId,
			photo: {
				storageId: storageId,
				fileName: "lifecycle.pdf",
				contentType: "application/pdf",
			},
		};
	}

	// Tests that deleting a case removes its unshared files, the link synchronously and the upload via the scheduled cleanup.
	it("deletes a case's unshared file (link synchronously, upload via the scheduled cleanup)", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, photo } = await makePhoto(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [personaPayload("A", { profilePhoto: photo })],
					roots: ["A"],
				}),
				owner,
			),
		);
		const beforeCaseFiles = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_case", (q) => q.eq("caseId", caseId))
				.collect(),
		);
		expect(beforeCaseFiles).toHaveLength(1);

		await t.run((ctx) => deleteCase(ctx, caseId, owner));
		await t.finishAllScheduledFunctions(() => {});

		const afterCaseFiles = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_case", (q) => q.eq("caseId", caseId))
				.collect(),
		);
		expect(afterCaseFiles).toHaveLength(0);
		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).toBeNull();
	});

	// Tests that deleting a case keeps a file that another case still references.
	it("does not delete a file still referenced by another case", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, photo } = await makePhoto(t);
		await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					name: "First",
					personas: [personaPayload("A", { profilePhoto: photo })],
					roots: ["A"],
				}),
				owner,
			),
		);
		const secondId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					name: "Second",
					personas: [personaPayload("A", { profilePhoto: photo })],
					roots: ["A"],
				}),
				owner,
			),
		);

		await t.run((ctx) => deleteCase(ctx, secondId, owner));
		await t.finishAllScheduledFunctions(() => {});

		const rows = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).not.toBeNull();
	});

	// Tests that a file dropped by an update is cleaned up unless another persona in the same case still uses it.
	it("cleans up a file dropped by an update, but keeps it if another persona in the same case still uses it", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, photo } = await makePhoto(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [
						personaPayload("A", { profilePhoto: photo }),
						personaPayload("B", { profilePhoto: photo }),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({
					personas: [
						personaPayload("A", { profilePhoto: null }),
						personaPayload("B", { profilePhoto: photo }),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);
		await t.finishAllScheduledFunctions(() => {});
		let rows = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).not.toBeNull();

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({
					personas: [
						personaPayload("A", { profilePhoto: null }),
						personaPayload("B", { profilePhoto: null }),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);
		await t.finishAllScheduledFunctions(() => {});
		rows = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).toBeNull();
	});
});
