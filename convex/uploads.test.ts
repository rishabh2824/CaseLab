import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import { newTestConvex, withAdmin } from "./test.setup";

describe("generateUploadUrls (batched)", () => {
	// Tests that generateUploadUrls returns exactly the requested number of distinct urls.
	it("returns exactly `count` distinct urls", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		const urls = await asUser.mutation(api.uploads.generateUploadUrls, {
			count: 5,
		});
		expect(urls).toHaveLength(5);
		expect(new Set(urls).size).toBe(5);
	});

	// Tests that generateUploadUrls returns an empty list for a count of zero.
	it("returns an empty list for a count of zero", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		await expect(
			asUser.mutation(api.uploads.generateUploadUrls, { count: 0 }),
		).resolves.toEqual([]);
	});

	// Tests that generateUploadUrls rejects negative, fractional, NaN, infinite and absurdly large counts.
	it.each([
		["negative", -1],
		["fractional", 2.5],
		["not a number", Number.NaN],
		["infinite", Number.POSITIVE_INFINITY],
		["absurdly large", 1_000_000],
	])(
		"rejects a %s count instead of silently mis-sizing the batch",
		async (_label, count) => {
			const t = newTestConvex();
			const { asUser } = await withAdmin(t);
			await expect(
				asUser.mutation(api.uploads.generateUploadUrls, { count }),
			).rejects.toThrow(/count/i);
		},
	);

	// Tests that generateUploadUrls accepts the largest batch a real case save could need.
	it("accepts the largest batch a real case save could need", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		await expect(
			asUser.mutation(api.uploads.generateUploadUrls, { count: 200 }),
		).resolves.toHaveLength(200);
	});
});

describe("discardUploads (undoing a failed create/update's uploads)", () => {
	// Tests that discardUploads deletes a storage object that no case claims.
	it("deletes a storage object no case claims", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["orphan"])),
		);

		await asUser.mutation(api.uploads.discardUploads, {
			storageIds: [storageId],
		});

		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).toBeNull();
	});

	// Tests that discardUploads leaves a storage object alone once a case claims it.
	it("leaves a storage object alone once a case claims it", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["claimed"])),
		);
		const owner = await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: "owner@test.caselab.invalid",
				role: "admin",
			}),
		);
		const caseId = await t.run((ctx) =>
			ctx.db.insert("cases", {
				name: "Case",
				brief: "Brief",
				commonInformation: "",
				accessCode: "claimcode",
				ownerAdminId: owner,
				isDemo: false,
				structure: { personas: [], referrals: [], roots: [] },
			}),
		);
		await t.run((ctx) => ctx.db.insert("caseFiles", { caseId, storageId }));

		await asUser.mutation(api.uploads.discardUploads, {
			storageIds: [storageId],
		});

		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).not.toBeNull();
	});

	// Tests that discardUploads is a no-op for an empty list.
	it("is a no-op for an empty list", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		await expect(
			asUser.mutation(api.uploads.discardUploads, { storageIds: [] }),
		).resolves.toBeNull();
	});
});
