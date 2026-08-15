import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { boundaryReply, elapsedMinutes, getChatState, personaAvailability } from "./turnState";

describe("personaAvailability", () => {
	it("reports not yet available when elapsed is before available_at", () => {
		expect(personaAvailability(null, 10, 5)).toEqual({ available: false, availableIn: 5, expiresIn: null });
	});

	it("never expires when availabilityDuration is null", () => {
		expect(personaAvailability(null, 10, 50)).toEqual({ available: true, availableIn: 0, expiresIn: null });
	});

	it("reports remaining time when a duration is set", () => {
		// available_at=10, duration=20 -> expires_at=30, elapsed=15 leaves 15.
		expect(personaAvailability(20, 10, 15)).toEqual({ available: true, availableIn: 0, expiresIn: 15 });
	});

	it("is still available exactly at the expiry boundary (elapsed === expiresAt)", () => {
		expect(personaAvailability(20, 10, 30)).toEqual({ available: true, availableIn: 0, expiresIn: 0 });
	});

	it("is expired one minute past the boundary", () => {
		expect(personaAvailability(20, 10, 31)).toEqual({ available: false, availableIn: null, expiresIn: 0 });
	});

	it("expires immediately with a zero duration", () => {
		expect(personaAvailability(0, 10, 1000)).toEqual({ available: false, availableIn: null, expiresIn: 0 });
	});

	it("is available for the instant elapsed === available_at with a zero duration", () => {
		expect(personaAvailability(0, 10, 10)).toEqual({ available: true, availableIn: 0, expiresIn: 0 });
	});

	it("invariants: available_in/expires_in are never negative, and available implies availableIn===0", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 500 }),
				fc.option(fc.integer({ min: 0, max: 500 }), { nil: null }),
				fc.integer({ min: 0, max: 1000 }),
				(availableAt, duration, elapsed) => {
					const result = personaAvailability(duration, availableAt, elapsed);
					if (result.availableIn !== null) expect(result.availableIn).toBeGreaterThanOrEqual(0);
					if (result.expiresIn !== null) expect(result.expiresIn).toBeGreaterThanOrEqual(0);
					if (result.available) expect(result.availableIn).toBe(0);
					if (!result.available) expect(result.availableIn === null || result.availableIn > 0).toBe(true);
				},
			),
		);
	});
});

describe("getChatState", () => {
	it("defaults for a persona with no recorded state", () => {
		expect(getChatState({}, "A")).toEqual({ ended: false, endReason: null, warningCount: 0 });
	});

	it("reads existing state without mutating the map", () => {
		const map = { A: { warningCount: 2, ended: false } };
		expect(getChatState(map, "A")).toEqual({ ended: false, endReason: null, warningCount: 2 });
	});

	it("maps a missing endReason to null rather than undefined", () => {
		const map = { A: { warningCount: 1, ended: true } };
		expect(getChatState(map, "A").endReason).toBeNull();
	});
});

describe("boundaryReply", () => {
	it("names the persona when ending the conversation", () => {
		expect(boundaryReply("Mary", true)).toMatch(/^Mary is ending this conversation/);
	});

	it("is a fixed warning regardless of name when not ending", () => {
		expect(boundaryReply("Mary", false)).toBe(
			"I am not able to follow that. Please send a clear, respectful, case-related " +
				"question if you want to continue.",
		);
	});

	it("falls back to 'I' for an empty name", () => {
		expect(boundaryReply("", true)).toMatch(/^I is ending this conversation/);
	});
});

describe("elapsedMinutes", () => {
	it("floors to whole minutes", () => {
		// 90 seconds elapsed = 1.5 minutes -> floors to 1, not 2.
		expect(elapsedMinutes(1_000_000_000 - 90_000, 1_000_000_000)).toBe(1);
	});

	it("handles an exact multiple of a minute", () => {
		expect(elapsedMinutes(1_000_000_000 - 120_000, 1_000_000_000)).toBe(2);
	});
});
