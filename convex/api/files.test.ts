// sweepOrphanedStorage is the weekly backstop for api/uploads.ts's discardUploads (see its own
// comment for the split) -- these tests pin the one thing that split depends on: never
// deleting a storage object still within its safety window, or one a `files` row claims.
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { newTestConvex } from "../test.setup";

const ONE_HOUR_MS = 60 * 60 * 1000;
const PAST_SAFETY_WINDOW_MS = 25 * ONE_HOUR_MS; // just past the 24h minimum age

describe("sweepOrphanedStorage", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("deletes an orphaned storage object once it's aged past the safety window", async () => {
		vi.useFakeTimers();
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["orphan"])),
		);

		vi.advanceTimersByTime(PAST_SAFETY_WINDOW_MS);
		await t.mutation(internal.api.files.sweepOrphanedStorage, {});

		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).toBeNull();
	});

	// The safety window exists because uploading and claiming (via a `files` row) are two
	// separate requests (submitCase.ts uploads, then calls create/update) -- a storage object
	// can legitimately sit unclaimed for that short gap.
	it("leaves a freshly uploaded orphan alone while it's still within the safety window", async () => {
		vi.useFakeTimers();
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["fresh"])),
		);

		vi.advanceTimersByTime(ONE_HOUR_MS);
		await t.mutation(internal.api.files.sweepOrphanedStorage, {});

		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).not.toBeNull();
	});

	it("never deletes a storage object a `files` row still claims, however old", async () => {
		vi.useFakeTimers();
		const t = newTestConvex();
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["claimed"])),
		);
		await t.run((ctx) =>
			ctx.db.insert("files", {
				storageId,
				name: "claimed.pdf",
				contentType: "application/pdf",
			}),
		);

		vi.advanceTimersByTime(PAST_SAFETY_WINDOW_MS);
		await t.mutation(internal.api.files.sweepOrphanedStorage, {});

		expect(
			await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
		).not.toBeNull();
	});

	// Regression test for a real bug: a prior version of this sweep took a fixed-size batch
	// and rescheduled itself (via ctx.scheduler.runAfter) whenever that batch came back full.
	// A claimed object is never removed from `_storage`, so once the table held at least one
	// batch's worth of ordinary, permanently-claimed files, the batch was full on every run and
	// never changed -- the reschedule fired again immediately, forever, without ever finding
	// anything left to clean up. This seeds more than that old batch size's worth of claimed,
	// aged objects and asserts a single run schedules no follow-up call of its own -- only
	// crons.ts's weekly interval should ever trigger this again.
	it("schedules no follow-up run of itself, however many claimed objects it walks past", async () => {
		vi.useFakeTimers();
		const t = newTestConvex();
		for (let i = 0; i < 250; i++) {
			const storageId = await t.run((ctx) =>
				ctx.storage.store(new Blob([`claimed-${i}`])),
			);
			await t.run((ctx) =>
				ctx.db.insert("files", {
					storageId,
					name: `claimed-${i}.pdf`,
					contentType: "application/pdf",
				}),
			);
		}

		vi.advanceTimersByTime(PAST_SAFETY_WINDOW_MS);
		await t.mutation(internal.api.files.sweepOrphanedStorage, {});

		const scheduled = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(scheduled).toHaveLength(0);
	});
});
