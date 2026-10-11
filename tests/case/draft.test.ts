import { describe, expect, it } from "vitest";
import { getPersonaFieldErrors } from "../../convex/lib/caseRules.js";
import {
	createEmptyPersona,
	createEmptyReferral,
	getPersonaLabel,
	hasFieldErrors,
	parseIntOrNull,
	referralsFrom,
	referralsTo,
} from "../../src/lib/case/draft.js";
import { makeReferral } from "../support/factories.js";

describe("createEmptyPersona", () => {
	// Tests that each empty persona gets its own unique id.
	it("assigns each persona a unique id", () => {
		const a = createEmptyPersona();
		const b = createEmptyPersona();
		expect(a.id).not.toBe(b.id);
	});

	// Tests that overrides are applied on top of the blank persona defaults.
	it("applies overrides on top of the blank defaults", () => {
		const persona = createEmptyPersona({ name: "Mary", role: "CFO" });
		expect(persona.name).toBe("Mary");
		expect(persona.role).toBe("CFO");
		expect(persona.files).toEqual([]);
	});
});

describe("createEmptyReferral", () => {
	// Tests that createEmptyReferral returns a blank referral and honors overrides.
	it("returns a blank referral with overrides applied", () => {
		expect(createEmptyReferral()).toEqual({
			fromId: "",
			toId: "",
			conditions: "",
		});
		expect(createEmptyReferral({ fromId: "p1" }).fromId).toBe("p1");
	});
});

describe("getPersonaLabel", () => {
	// Tests that getPersonaLabel returns the trimmed name when one is present.
	it("returns the trimmed name when present", () => {
		expect(getPersonaLabel({ name: "  Mary  " }, "fallback")).toBe("Mary");
	});

	// Tests that getPersonaLabel uses the fallback for a whitespace-only name.
	it("falls back when the name is whitespace-only", () => {
		expect(getPersonaLabel({ name: "   " }, "fallback")).toBe("fallback");
	});

	// Tests that getPersonaLabel uses the fallback for an empty name.
	it("falls back when the name is empty", () => {
		expect(getPersonaLabel({ name: "" }, "fallback")).toBe("fallback");
	});
});

describe("hasFieldErrors", () => {
	// Tests that field errors from an incomplete persona are reported as errors.
	it("is true for a persona with a field error", () => {
		const persona = createEmptyPersona({ name: "  ", role: "CFO" });
		expect(hasFieldErrors(getPersonaFieldErrors(persona))).toBe(true);
	});

	// Tests that a valid persona has no field errors.
	it("is false for a fully valid persona", () => {
		const persona = createEmptyPersona({ name: "Mary", role: "CFO" });
		expect(hasFieldErrors(getPersonaFieldErrors(persona))).toBe(false);
	});
});

describe("referralsFrom / referralsTo", () => {
	const referrals = [
		makeReferral("p1", "p2"),
		makeReferral("p1", "p3"),
		makeReferral("p2", "p3"),
	];

	// Tests that referralsFrom returns only the edges a given persona authored.
	it("referralsFrom returns edges authored by the given persona", () => {
		expect(referralsFrom(referrals, "p1")).toEqual([
			makeReferral("p1", "p2"),
			makeReferral("p1", "p3"),
		]);
	});

	// Tests that referralsTo returns every edge pointing at a persona, including from multiple parents.
	it("referralsTo returns edges pointing at the given persona (possibly multiple parents)", () => {
		expect(referralsTo(referrals, "p3")).toEqual([
			makeReferral("p1", "p3"),
			makeReferral("p2", "p3"),
		]);
	});

	// Tests that referralsFrom/referralsTo return an empty array when no edges match.
	it("returns [] when no edges match", () => {
		expect(referralsFrom(referrals, "p3")).toEqual([]);
		expect(referralsTo(referrals, "p1")).toEqual([]);
	});
});

describe("parseIntOrNull", () => {
	// Tests that blank and non-numeric input is null.
	it.each(["", "abc", "Infinity", "NaN"])("returns null for %j", (raw) => {
		expect(parseIntOrNull(raw)).toBeNull();
	});

	// Tests that numbers are truncated toward zero, not rounded.
	it.each([
		["12", 12],
		["12.9", 12],
		["-3.7", -3],
		["0", 0],
	])("parses %j as %i", (raw, expected) => {
		expect(parseIntOrNull(raw)).toBe(expected);
	});
});
