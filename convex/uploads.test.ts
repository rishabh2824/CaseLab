import { afterEach, describe, expect, it, vi } from "vitest";
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
				name: "Test Admin",
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
				isTemplate: false,
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

	// Tests that discardUploads refuses a batch over the 200 limit and deletes nothing.
	it("refuses more than 200 ids and deletes nothing", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		const storageIds = await t.run((ctx) =>
			Promise.all(
				Array.from({ length: 201 }, (_, i) =>
					ctx.storage.store(new Blob([`blob-${i}`])),
				),
			),
		);

		await expect(
			asUser.mutation(api.uploads.discardUploads, { storageIds }),
		).rejects.toThrow(/more than 200/);

		const first = storageIds[0]!;
		expect(await t.run((ctx) => ctx.storage.getUrl(first))).not.toBeNull();
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

describe("sweepAbandonedUploads (weekly cleanup of uploads no save ever claimed)", () => {
	const DAY_MS = 24 * 60 * 60_000;

	afterEach(() => {
		vi.useRealTimers();
	});

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
				structure: { personas: [], referrals: [], roots: [] },
			});
		});
	}

	// Tests that old unclaimed uploads are deleted while claimed and recent ones survive.
	it("deletes old unclaimed uploads but keeps claimed and recent ones", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
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
		vi.setSystemTime(Date.now() + 2 * DAY_MS);
		const recent = await t.run((ctx) =>
			ctx.storage.store(new Blob(["recent"])),
		);

		await t.mutation(internal.files.sweepAbandonedUploads, {});

		const exists = (id: Id<"_storage">) =>
			t.run(async (ctx) => (await ctx.db.system.get("_storage", id)) !== null);
		expect(await exists(orphan!)).toBe(false);
		expect(await exists(claimed!)).toBe(true);
		expect(await exists(recent)).toBe(true);
	});

	// Tests that the sweep carries on past the first batch.
	it("keeps going past the first batch", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const t = newTestConvex();
		const ids = await t.run((ctx) =>
			Promise.all(
				Array.from({ length: 250 }, (_, i) =>
					ctx.storage.store(new Blob([`orphan-${i}`])),
				),
			),
		);
		vi.setSystemTime(Date.now() + 2 * DAY_MS);

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
