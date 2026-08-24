// The upload surface is small but it is a public, authenticated mutation that allocates
// resources from an unvalidated caller-supplied number. authz.test.ts covers the auth gate;
// this covers what the gate lets through.
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { newTestConvex, withAdmin } from "../test.setup";

describe("generateUploadUrls (batched)", () => {
	it("returns exactly `count` distinct urls", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		const urls = await asUser.mutation(api.api.uploads.generateUploadUrls, {
			count: 5,
		});
		expect(urls).toHaveLength(5);
		expect(new Set(urls).size).toBe(5);
	});

	// A case save with no new files asks for zero urls (submitCase.ts short-circuits, but the
	// mutation must not depend on that).
	it("returns an empty list for a count of zero", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		await expect(
			asUser.mutation(api.api.uploads.generateUploadUrls, { count: 0 }),
		).resolves.toEqual([]);
	});

	// `count` was passed straight to Array.from({ length: count }) with no validation, so a
	// negative or fractional value silently produced a wrong-length array (the client pairs
	// urls to files positionally, so a short array means a file is uploaded to the wrong url or
	// not at all), and an absurd count let one authenticated request allocate unbounded work.
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
				asUser.mutation(api.api.uploads.generateUploadUrls, { count }),
			).rejects.toThrow(/count/i);
		},
	);

	it("accepts the largest batch a real case save could need", async () => {
		const t = newTestConvex();
		const { asUser } = await withAdmin(t);
		await expect(
			asUser.mutation(api.api.uploads.generateUploadUrls, { count: 200 }),
		).resolves.toHaveLength(200);
	});
});
