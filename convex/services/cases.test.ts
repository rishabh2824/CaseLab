import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
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

function payload(overrides: Partial<CasePayload> = {}): CasePayload {
	return {
		name: "Sterling Industries",
		brief: "Reduce office supply costs.",
		accessCode: uniqueAccessCode(),
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

	// PersonaFields.svelte's `{#each ownReferrals as referral (referral.to_id)}` keys on
	// exactly this pair -- a duplicate would break Svelte's keyed reconciliation the next time
	// the case is loaded back into the editor.
	it("rejects a duplicate (from_id, to_id) referral pair", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A"), personaPayload("B")],
				[referralEdge("A", "B"), referralEdge("A", "B")],
				["A"],
			),
		).toThrow(/Duplicate referral/);
	});

	// CaseGraphEditor.svelte's `{#each graph.roots as rootId (rootId)}` keys on the root id
	// alone -- same failure mode as the duplicate-referral case above.
	it("rejects a duplicate root persona id", () => {
		expect(() => validateGraph([personaPayload("A")], [], ["A", "A"])).toThrow(
			/Duplicate root/,
		);
	});

	it("rejects a persona with a blank name", () => {
		expect(() =>
			validateGraph([personaPayload("A", { name: "  " })], [], ["A"]),
		).toThrow(/missing a name/);
	});

	it("rejects a persona with a blank role", () => {
		expect(() =>
			validateGraph([personaPayload("A", { role: "" })], [], ["A"]),
		).toThrow(/missing a role/);
	});

	it.each([0, -5, 2.5])(
		"rejects a persona availability of %s minutes",
		(availability_minutes) => {
			expect(() =>
				validateGraph(
					[personaPayload("A", { availability_minutes })],
					[],
					["A"],
				),
			).toThrow(/availability/);
		},
	);

	it("accepts a persona with no availability set at all", () => {
		expect(() =>
			validateGraph(
				[personaPayload("A", { availability_minutes: null })],
				[],
				["A"],
			),
		).not.toThrow();
	});

	// A persona id is written straight into an HTML attribute (data-persona-id, an <option>'s
	// value) and, for a case's root persona, into an inline <script> block when an admin
	// exports a template (exportCase.ts) -- see PERSONA_ID_FORMAT's own comment for the attack
	// this format restriction closes off at the source. A wider charset previously accepted
	// anything printable and non-"$"; this pins that a value like this is rejected here, at
	// save time, rather than only being caught by exportCase.ts's own (separate) escaping.
	it("rejects a persona id containing characters unsafe for an HTML attribute", () => {
		const dangerousId = `"><script>alert(1)</script>`;
		expect(() =>
			validateGraph([personaPayload(dangerousId)], [], [dangerousId]),
		).toThrow(/Invalid persona id/);
	});

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

describe("replaceCollaborators addedAt (via updateCase)", () => {
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
				.withIndex("by_case", (q) => q.eq("caseId", caseId))
				.first(),
		);

		// Same collaborator list, unrelated field changed -- the row (and its addedAt)
		// should survive untouched, not get deleted and reinserted.
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
				.withIndex("by_case", (q) => q.eq("caseId", caseId))
				.first(),
		);

		expect(rowAfter?._id).toBe(rowBefore?._id);
		expect(rowAfter?.addedAt).toBe(rowBefore?.addedAt);
	});

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
				.withIndex("by_case", (q) => q.eq("caseId", caseId))
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
				.withIndex("by_case", (q) => q.eq("caseId", caseId))
				.collect(),
		);
		expect(rows).toHaveLength(2);
		const originalRowAfter = rows.find((row) => row.adminId === original._id);
		expect(originalRowAfter?._id).toBe(originalRowBefore?._id);
		expect(originalRowAfter?.addedAt).toBe(originalRowBefore?.addedAt);
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

describe("required fields (via createCase)", () => {
	it("rejects a blank name", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ name: "   " }), owner)),
		).rejects.toThrow("Case name is required.");
	});

	it("rejects a blank brief", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ brief: "" }), owner)),
		).rejects.toThrow("Initial brief is required.");
	});

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

	it("leaves common information unset when the payload doesn't provide it", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		const caseId = await t.run((ctx) => createCase(ctx, payload(), owner));
		const c = (await t.run((ctx) => ctx.db.get(caseId)))!;
		expect(c.commonInformation).toBeUndefined();
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

	it("rejects a blank or whitespace-only access code -- every case needs a real one", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		await expect(
			t.run((ctx) => createCase(ctx, payload({ accessCode: "   " }), owner)),
		).rejects.toThrow("Access code is required.");
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
		const _caseId = await t.run((ctx) =>
			createCase(
				ctx,
				payload({
					personas: [
						personaPayload("A", {
							profile_photo: {
								storage_id: storageId,
								file_name: "shared.pdf",
								content_type: "application/pdf",
							},
						}),
						personaPayload("B", {
							profile_photo: {
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

		const rows = await t.run((ctx) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
	});
});

describe("resolveFileRefs against a storage id with no backing object", () => {
	// A ref pointing at a storage id that never existed, or existed and was since deleted (e.g.
	// a template load carried over a photo whose object the orphan sweep since cleaned up) --
	// resolveFileRefs must not insert a `files` row for something ctx.storage can't actually
	// serve. buildStructure's lookup then treats the ref as unset (same tradeoff already
	// documented for a fileless attachment slot), dropping just that one photo rather than
	// failing the whole save.
	it("drops a photo ref whose storage id doesn't exist, saving the rest of the case fine", async () => {
		const t = newTestConvex();
		const owner = await makeAdmin(t);
		// A validly-shaped storage id that genuinely no longer resolves to anything -- stored,
		// then deleted, rather than a hand-typed string, since the real failure mode is "the
		// object existed and was since cleaned up" (e.g. a template's photo the orphan sweep
		// already reclaimed), not a malformed id.
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
							profile_photo: {
								storage_id: ghostStorageId,
								file_name: "gone.pdf",
								content_type: "application/pdf",
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
			personas: { profile_photo: unknown }[];
		};
		expect(structure.personas[0]?.profile_photo).toBeNull();
		const rows = await t.run((ctx) =>
			ctx.db
				.query("files")
				.withIndex("by_storage_id", (q) => q.eq("storageId", ghostStorageId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
	});
});

describe("file lifecycle (caseFiles reconciliation + orphan cleanup)", () => {
	// Deletion goes through ctx.storage.delete (a normal transactional Convex operation, not
	// a network call), so this needs no fetch mocking or env stubbing to exercise the
	// cleanup path.
	async function makePhoto(t: ReturnType<typeof newTestConvex>) {
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
		return {
			storageId,
			photo: {
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
