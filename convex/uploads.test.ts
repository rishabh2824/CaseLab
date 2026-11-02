import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

describe("sweepAbandonedUploads (weekly cleanup of uploads no save ever claimed)", () => {
	// Creates a case row to hang caseFiles links off.
	async function makeCase(t: ReturnType<typeof newTestConvex>) {
		return await t.run(async (ctx) => {
			const owner = await ctx.db.insert("admins", {
				name: "Test Admin",
				email: "owner@test.caselab.invalid",
				role: "admin",
			});
			return await ctx.db.insert("cases", {
				name: "Case",
				brief: "Brief",
				commonInformation: "",
				accessCode: "sweepcode",
				ownerAdminId: owner,
				isTemplate: false,
				structure: { personas: [], referrals: [] },
			});
		});
	}

	// Tests that unclaimed uploads are deleted while claimed ones survive.
	it("deletes unclaimed uploads but keeps claimed ones", async () => {
		const t = newTestConvex();
		const caseId = await makeCase(t);
		const [orphan, claimed] = await t.run((ctx) =>
			Promise.all([
				ctx.storage.store(new Blob(["orphan"])),
				ctx.storage.store(new Blob(["claimed"])),
			]),
		);
		await t.run((ctx) =>
			ctx.db.insert("caseFiles", { caseId, storageId: claimed! }),
		);

		await t.mutation(internal.files.sweepAbandonedUploads, {});

		const exists = (id: Id<"_storage">) =>
			t.run(async (ctx) => (await ctx.db.system.get("_storage", id)) !== null);
		expect(await exists(orphan!)).toBe(false);
		expect(await exists(claimed!)).toBe(true);
	});

	// Tests that the sweep carries on past the first batch.
	it("keeps going past the first batch", async () => {
		const t = newTestConvex();
		const ids = await t.run((ctx) =>
			Promise.all(
				Array.from({ length: 250 }, (_, i) =>
					ctx.storage.store(new Blob([`orphan-${i}`])),
				),
			),
		);

		await t.mutation(internal.files.sweepAbandonedUploads, {});
		await t.finishAllScheduledFunctions(() => {});

		const remaining = await t.run(async (ctx) =>
			(
				await Promise.all(ids.map((id) => ctx.db.system.get("_storage", id)))
			).filter(Boolean),
		);
		expect(remaining).toHaveLength(0);
	});
});
