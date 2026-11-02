import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { elapsedMinutes, personaAvailability } from "./availability";

describe("personaAvailability", () => {
	// Tests that a persona with a null availability duration never expires.
	it("never expires when availabilityDuration is null", () => {
		expect(personaAvailability(null, 10, 50)).toEqual({
			available: true,
			expiresIn: null,
		});
	});

	// Tests that a persona inside its window reports the minutes left.
	it("reports the minutes left inside the window", () => {
		expect(personaAvailability(20, 10, 15)).toEqual({
			available: true,
			expiresIn: 15,
		});
	});

	// Tests that the last minute of the window is still available.
	it("stays available at exactly the expiry minute", () => {
		expect(personaAvailability(20, 10, 30)).toEqual({
			available: true,
			expiresIn: 0,
		});
	});

	// Tests that a persona is unavailable once the window has passed.
	it("is unavailable after the window passes", () => {
		expect(personaAvailability(20, 10, 31)).toEqual({
			available: false,
			expiresIn: 0,
		});
	});

	// Tests that a zero-length window is available only at the minute the persona unlocked.
	it("treats a zero-length window as that single minute", () => {
		expect(personaAvailability(0, 10, 10).available).toBe(true);
		expect(personaAvailability(0, 10, 11).available).toBe(false);
	});

	// Tests that expiresIn is never negative and an unavailable persona has none left, for arbitrary inputs.
	it("invariants: expiresIn is never negative, and unavailable means expired", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 500 }),
				fc.option(fc.integer({ min: 0, max: 500 }), { nil: null }),
				fc.integer({ min: 0, max: 1000 }),
				(availableAt, duration, elapsed) => {
					const result = personaAvailability(duration, availableAt, elapsed);
					if (result.expiresIn !== null)
						expect(result.expiresIn).toBeGreaterThanOrEqual(0);
					if (!result.available) expect(result.expiresIn).toBe(0);
				},
			),
		);
	});
});

describe("elapsedMinutes", () => {
	// Tests that elapsedMinutes floors to whole minutes.
	it("floors to whole minutes", () => {
		expect(elapsedMinutes(1_000_000_000 - 90_000, 1_000_000_000)).toBe(1);
	});

	// Tests that a start time slightly in the future gives zero rather than a negative number.
	it("never returns a negative number", () => {
		expect(elapsedMinutes(1_000_000_000 + 0.001, 1_000_000_000)).toBe(0);
	});

	// Tests that elapsedMinutes handles an exact multiple of a minute.
	it("handles an exact multiple of a minute", () => {
		expect(elapsedMinutes(1_000_000_000 - 120_000, 1_000_000_000)).toBe(2);
	});
});
