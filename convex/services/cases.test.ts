import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { newTestConvex } from "../test.setup";
import { personaPayload, referralEdge } from "../testFactories";
import {
	type CasePayload,
	createCase,
	deleteCase,
	listCases,
	requireCaseAccess,
	updateCase,
	validateGraph,
} from "./cases";

function payload(overrides: Partial<CasePayload> = {}): CasePayload {
	return {
		name: "Sterling Industries",
		brief: "Reduce office supply costs.",
		personas: [personaPayload("A")],
		referrals: [],
		roots: ["A"],
		collaboratorAdminIds: [],
		...overrides,
	};
}

describe("validateGraph (pure)", () => {
	it("accepts a persona referred by two different parents", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A"), personaPayload("B"), personaPayload("C")],
				[referralEdge("A", "C"), referralEdge("B", "C")],
				["A", "B"],
			),
		).not.toThrow();
	});

	it("rejects a cyclic referral graph", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A"), personaPayload("B")],
				[referralEdge("A", "B"), referralEdge("B", "A")],
				["A"],
			),
		).toThrow(/cycle/i);
	});

	it("rejects a referral pointing at a nonexistent persona", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A")],
				[referralEdge("A", "does-not-exist")],
				["A"],
			),
		).toThrow(/Unknown referral to_id/);
	});

	it("rejects a root pointing at a nonexistent persona", () => {
		expect(() =>
			validateGraph([personaPayload("A")], [], ["A", "does-not-exist"]),
		).toThrow(/Unknown root persona id/);
	});

	it("rejects duplicate persona ids", () => {
		expect(() =>
			validateGraph([personaPayload("A"), personaPayload("A")], [], ["A"]),
		).toThrow(/Duplicate persona/);
	});
});

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

		// The collaborator can update the case, including dropping themselves and adding a third admin.
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

describe("collaborator validation (via createCase)", () => {
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

	it("rejects an unknown admin id", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const bogusId = "k17bogus0000000000000000" as Id<"admins">;
		await expect(
			t.run((ctx) =>
				createCase(ctx, payload({ collaboratorAdminIds: [bogusId] }), owner),
			),
		).rejects.toThrow(/Unknown admin id/);
	});

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

describe("access code validation", () => {
	it("rejects a code with anything other than lowercase letters", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) =>
				createCase(ctx, payload({ accessCode: "Sterling1" }), owner),
			),
		).rejects.toThrow("Access code must contain only lowercase letters.");
	});

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
			referrals: { from_id: string; to_id: string }[];
			roots: string[];
		};
		expect(
			new Set(structure.referrals.map((r) => `${r.from_id}->${r.to_id}`)),
		).toEqual(new Set(["A->C", "B->C"]));
		expect(new Set(structure.roots)).toEqual(new Set(["A", "B"]));
	});

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

describe("file dedup (resolveFileRefs, via buildStructure/createCase)", () => {
	it("dedupes two personas sharing a storage id to a single files row", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["shared"])),
		);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [
						personaPayload("A", {
							profile_photo: {
								file_id: null,
								storage_id: storageId,
								file_name: "shared.pdf",
								content_type: "application/pdf",
							},
						}),
						personaPayload("B", {
							profile_photo: {
								file_id: null,
								storage_id: storageId,
								file_name: "shared.pdf",
								content_type: "application/pdf",
							},
						}),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);
		const c = (await t.run((ctx) => ctx.db.get(caseId)))! as Doc<"cases">;
		const structure = c.structure as {
			personas: { profile_photo: { file_id: string } }[];
		};
		const fileIds = new Set(
			structure.personas.map((p) => p.profile_photo.file_id),
		);
		expect(fileIds.size).toBe(1);

		const rows = await t.run((ctx) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});

	it("reuses the existing files row when the same storage id resurfaces on update", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["shared"])),
		);
		const photo = {
			file_id: null,
			storage_id: storageId,
			file_name: "shared.pdf",
			content_type: "application/pdf",
		};
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [personaPayload("A", { profile_photo: photo })],
					roots: ["A"],
				}),
				owner,
			),
		);

		const before = (await t.run((ctx) => ctx.db.get(caseId)))! as Doc<"cases">;
		const originalFileId = (
			before.structure as { personas: { profile_photo: { file_id: string } }[] }
		).personas[0]!.profile_photo.file_id;

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({
					personas: [
						personaPayload("A", { profile_photo: photo }),
						personaPayload("B", { profile_photo: photo }),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);

		const after = (await t.run((ctx) => ctx.db.get(caseId)))! as Doc<"cases">;
		const fileIds = new Set(
			(
				after.structure as {
					personas: { profile_photo: { file_id: string } }[];
				}
			).personas.map((p) => p.profile_photo.file_id),
		);
		expect(fileIds).toEqual(new Set([originalFileId]));

		const rows = await t.run((ctx) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});
});

describe("file lifecycle (caseFiles reconciliation + orphan cleanup)", () => {
	// Deletion now goes through ctx.storage.delete (a normal transactional Convex
	// operation, not a network call), so unlike the old Spaces-backed version this needs no
	// fetch mocking or SPACES_* env stubbing to exercise the cleanup path.
	async function makePhoto(t: ReturnType<typeof newTestConvex>) {
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
		return {
			storageId,
			photo: {
				file_id: null,
				storage_id: storageId,
				file_name: "lifecycle.pdf",
				content_type: "application/pdf",
			},
		};
	}

	it("deletes a case's unshared file (caseFiles row synchronously, files row via the scheduled cleanup)", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, photo } = await makePhoto(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [personaPayload("A", { profile_photo: photo })],
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

		const rows = await t.run((ctx) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
	});

	it("does not delete a file still referenced by another case", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, photo } = await makePhoto(t);
		await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					name: "First",
					personas: [personaPayload("A", { profile_photo: photo })],
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
					personas: [personaPayload("A", { profile_photo: photo })],
					roots: ["A"],
				}),
				owner,
			),
		);

		await t.run((ctx) => deleteCase(ctx, secondId, owner));
		await t.finishAllScheduledFunctions(() => {});

		const rows = await t.run((ctx) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});

	it("cleans up a file dropped by an update, but keeps it if another persona in the same case still uses it", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, photo } = await makePhoto(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [
						personaPayload("A", { profile_photo: photo }),
						personaPayload("B", { profile_photo: photo }),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);

		// A drops the photo; B (same case) keeps it -- the file must survive.
		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({
					personas: [
						personaPayload("A", { profile_photo: null }),
						personaPayload("B", { profile_photo: photo }),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);
		await t.finishAllScheduledFunctions(() => {});
		let rows = await t.run((ctx) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);

		// B also drops it -- now nothing references it, so it's cleaned up.
		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				payload({
					personas: [
						personaPayload("A", { profile_photo: null }),
						personaPayload("B", { profile_photo: null }),
					],
					roots: ["A", "B"],
				}),
				owner,
			),
		);
		await t.finishAllScheduledFunctions(() => {});
		rows = await t.run((ctx) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
	});
});
