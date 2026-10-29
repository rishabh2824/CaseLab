import { describe, expect, it } from "vitest";
import { personaPayload, referralEdge } from "../../tests/support/factories";
import type { Doc, Id } from "../_generated/dataModel";
import { casePayload, makeAdmin, newTestConvex } from "../test.setup";
import {
	createCase,
	deleteCase,
	listCaseAuthors,
	listCases,
	requireCaseAccess,
	updateCase,
} from "./cases";

describe("case access control", () => {
	// Tests that the owner can read, update and delete their own case.
	it("lets the owner read, update, and delete their own case", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) => createCase(ctx, casePayload(), owner));
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		await expect(
			t.run((ctx) => requireCaseAccess(ctx, c, owner)),
		).resolves.toBeNull();
		await expect(
			t.run((ctx) =>
				updateCase(ctx, caseId, casePayload({ name: "Renamed" }), owner),
			),
		).resolves.toBeNull();
		expect((await t.run((ctx) => ctx.db.get(caseId)))?.name).toBe("Renamed");

		await t.run((ctx) => deleteCase(ctx, caseId, owner));
		expect(await t.run((ctx) => ctx.db.get(caseId))).toBeNull();
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
				casePayload({
					collaborators: [{ adminId: collaborator._id, access: "edit" }],
				}),
				owner,
			),
		);

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				casePayload({
					collaborators: [{ adminId: third._id, access: "edit" }],
				}),
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

	// Tests that a regular admin's case list includes owned and collaborator cases but not unrelated ones.
	it("lists owned and collaborator cases for a regular admin, excluding unrelated cases", async () => {
		const t = newTestConvex();
		const a = await makeAdmin(t);
		const b = await makeAdmin(t);
		await t.run((ctx) =>
			createCase(ctx, casePayload({ name: "Owned by A" }), a),
		);
		const sharedId = await t.run((ctx) =>
			createCase(
				ctx,
				casePayload({
					name: "Shared with B",
					collaborators: [{ adminId: b._id, access: "edit" }],
				}),
				a,
			),
		);
		await t.run((ctx) =>
			createCase(ctx, casePayload({ name: "Unrelated" }), a),
		);

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
			createCase(ctx, casePayload({ name: "Owned by A" }), a),
		);

		const listing = await t.run((ctx) => listCases(ctx, superAdmin));
		expect(listing.map((c) => c._id)).toContain(caseId);
	});
});

describe("view-only collaborators", () => {
	async function setup() {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const viewer = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				casePayload({
					collaborators: [{ adminId: viewer._id, access: "view" }],
				}),
				owner,
			),
		);
		return { t, owner, viewer, caseId };
	}

	// Tests that a viewer can read the case but is refused every change.
	it("lets a viewer see the case but refuses update and delete", async () => {
		const { t, viewer, caseId } = await setup();
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;

		await expect(
			t.run((ctx) => requireCaseAccess(ctx, c, viewer, "view")),
		).resolves.toBeNull();
		await expect(
			t.run((ctx) => updateCase(ctx, caseId, casePayload(), viewer)),
		).rejects.toThrow("You have view-only access to this case.");
		await expect(
			t.run((ctx) => deleteCase(ctx, caseId, viewer)),
		).rejects.toThrow("You have view-only access to this case.");
	});

	// Tests that the viewer's list entry says they cannot edit, while the owner's says they can.
	it("marks the case as not editable in the viewer's list only", async () => {
		const { t, owner, viewer, caseId } = await setup();

		const asViewer = await t.run((ctx) => listCases(ctx, viewer));
		const asOwner = await t.run((ctx) => listCases(ctx, owner));

		expect(asViewer.find((c) => c._id === caseId)?.canEdit).toBe(false);
		expect(asOwner.find((c) => c._id === caseId)?.canEdit).toBe(true);
	});

	// Tests that changing only the access level updates the existing row rather than replacing it.
	it("changes a collaborator's access in place", async () => {
		const { t, owner, viewer, caseId } = await setup();
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
				casePayload({
					collaborators: [{ adminId: viewer._id, access: "edit" }],
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
		expect(rowAfter?.access).toBe("edit");
	});
});

describe("replaceCollaborators row stability (via updateCase)", () => {
	// Tests that an existing collaborator's row is left untouched across an unrelated save.
	it("keeps an existing collaborator's row across an unrelated save", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const collaborator = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				casePayload({
					collaborators: [{ adminId: collaborator._id, access: "edit" }],
				}),
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
				casePayload({
					collaborators: [{ adminId: collaborator._id, access: "edit" }],
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
			createCase(
				ctx,
				casePayload({
					collaborators: [{ adminId: original._id, access: "edit" }],
				}),
				owner,
			),
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
				casePayload({
					collaborators: [
						{ adminId: original._id, access: "edit" },
						{ adminId: added._id, access: "edit" },
					],
				}),
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
				createCase(
					ctx,
					casePayload({
						collaborators: [{ adminId: owner._id, access: "edit" }],
					}),
					owner,
				),
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
				createCase(
					ctx,
					casePayload({
						collaborators: [{ adminId: bogusId, access: "edit" }],
					}),
					owner,
				),
			),
		).rejects.toThrow(/Unknown admin id/);
	});

	// Tests that a super admin can be added as a collaborator so they can be credited as an author.
	it("accepts a super admin as a collaborator", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const superAdmin = await makeAdmin(t, "super");
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				casePayload({
					collaborators: [{ adminId: superAdmin._id, access: "edit" }],
				}),
				owner,
			),
		);
		const rows = await t.run((ctx) =>
			ctx.db
				.query("collaborators")
				.withIndex("by_case_and_admin", (q) => q.eq("caseId", caseId))
				.collect(),
		);
		expect(rows.map((row) => row.adminId)).toEqual([superAdmin._id]);
	});
});

describe("listCaseAuthors", () => {
	const named = (t: ReturnType<typeof newTestConvex>, name: string) =>
		t.run(async (ctx) => {
			const id = await ctx.db.insert("admins", {
				email: `${name.toLowerCase()}@test.caselab.invalid`,
				name,
				role: "admin",
			});
			return (await ctx.db.get(id))!;
		});

	// Tests that the owner comes first, followed by edit collaborators only.
	it("lists the owner then edit collaborators, leaving out view-only ones", async () => {
		const t = newTestConvex();
		const owner = await named(t, "Olive");
		const editor = await named(t, "Edith");
		const viewer = await named(t, "Vera");
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				casePayload({
					collaborators: [
						{ adminId: viewer._id, access: "view" },
						{ adminId: editor._id, access: "edit" },
					],
				}),
				owner,
			),
		);
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;

		await expect(t.run((ctx) => listCaseAuthors(ctx, c))).resolves.toEqual([
			"Olive",
			"Edith",
		]);
	});

	// Tests that a super admin who never collaborated is not credited, though they can edit.
	it("does not list a super admin who is not a collaborator", async () => {
		const t = newTestConvex();
		const owner = await named(t, "Olive");
		await makeAdmin(t, "super");
		const caseId = await t.run((ctx) => createCase(ctx, casePayload(), owner));
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;

		await expect(t.run((ctx) => listCaseAuthors(ctx, c))).resolves.toEqual([
			"Olive",
		]);
	});
});

describe("required fields (via createCase)", () => {
	// Tests that a blank case name is rejected.
	it("rejects a blank name", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, casePayload({ name: "   " }), owner)),
		).rejects.toThrow("Case name is required.");
	});

	// Tests that a name and brief are trimmed before being stored.
	it("trims a name/brief with surrounding whitespace before storing it", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) =>
			createCase(
				ctx,
				casePayload({ name: "  Sterling Industries  ", brief: "  Do it.  " }),
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
				casePayload({
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
		const caseId = await t.run((ctx) => createCase(ctx, casePayload(), owner));
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		expect(c.commonInformation).toBe("");
	});
});

describe("access code validation", () => {
	// Tests that a duplicate access code on a second case is rejected.
	it("rejects a duplicate access code on a second case", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await t.run((ctx) =>
			createCase(ctx, casePayload({ accessCode: "sterling" }), owner),
		);
		await expect(
			t.run((ctx) =>
				createCase(ctx, casePayload({ accessCode: "sterling" }), owner),
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
			createCase(ctx, casePayload({ accessCode: "sterling" }), owner),
		);
		await expect(
			t.run((ctx) =>
				updateCase(
					ctx,
					caseId,
					casePayload({ accessCode: "sterling", name: "Renamed" }),
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
				casePayload({
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
				casePayload({ personas: [personaPayload("A")], roots: ["A"] }),
				owner,
			),
		);

		await t.run((ctx) =>
			updateCase(
				ctx,
				caseId,
				casePayload({
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
				casePayload({
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
				casePayload({
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
				casePayload({
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

describe("teaching notes", () => {
	async function makeNotes(t: ReturnType<typeof newTestConvex>) {
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["n"])));
		return { storageId, notes: { storageId, fileName: "notes.pdf" } };
	}

	// Tests that the notes are stored on the case and linked so the file is kept.
	it("stores the notes and links the file to the case", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, notes } = await makeNotes(t);
		const caseId = await t.run((ctx) =>
			createCase(ctx, casePayload({ teachingNotes: notes }), owner),
		);

		const c = await t.run((ctx) => ctx.db.get(caseId));
		expect(c?.teachingNotes).toEqual(notes);
		const rows = await t.run((ctx) =>
			ctx.db
				.query("caseFiles")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});

	// Tests that removing the notes on update clears the field and deletes the upload.
	it("clears the field and cleans up the file when the notes are removed", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, notes } = await makeNotes(t);
		const caseId = await t.run((ctx) =>
			createCase(ctx, casePayload({ teachingNotes: notes }), owner),
		);

		await t.run((ctx) =>
			updateCase(ctx, caseId, casePayload({ teachingNotes: undefined }), owner),
		);
		await t.finishAllScheduledFunctions(() => {});

		const c = await t.run((ctx) => ctx.db.get(caseId));
		expect(c?.teachingNotes).toBeUndefined();
		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).toBeNull();
	});

	// Tests that deleting the case deletes the notes file too.
	it("deletes the notes file along with the case", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, notes } = await makeNotes(t);
		const caseId = await t.run((ctx) =>
			createCase(ctx, casePayload({ teachingNotes: notes }), owner),
		);

		await t.run((ctx) => deleteCase(ctx, caseId, owner));
		await t.finishAllScheduledFunctions(() => {});

		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).toBeNull();
	});

	// Tests that a notes reference whose upload is gone is dropped while the case still saves.
	it("drops notes whose upload no longer exists", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const { storageId, notes } = await makeNotes(t);
		await t.run((ctx) => ctx.storage.delete(storageId));

		const caseId = await t.run((ctx) =>
			createCase(ctx, casePayload({ teachingNotes: notes }), owner),
		);

		const c = await t.run((ctx) => ctx.db.get(caseId));
		expect(c?.teachingNotes).toBeUndefined();
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
				casePayload({
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
				casePayload({
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
				casePayload({
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
				casePayload({
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
				casePayload({
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
				casePayload({
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
				casePayload({
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
