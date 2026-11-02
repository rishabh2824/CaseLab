import { describe, expect, it } from "vitest";
import {
	createEmptyPersona,
	createEmptyReferral,
	getPersonaLabel,
	numberInputValue,
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

describe("referralsTo", () => {
	const referrals = [
		makeReferral("p1", "p2"),
		makeReferral("p1", "p3"),
		makeReferral("p2", "p3"),
	];

	// Tests that referralsTo returns every edge pointing at a persona, including from multiple parents.
	it("referralsTo returns edges pointing at the given persona (possibly multiple parents)", () => {
		expect(referralsTo(referrals, "p3")).toEqual([
			makeReferral("p1", "p3"),
			makeReferral("p2", "p3"),
		]);
	});

	// Tests that referralsTo returns an empty array when no edges match.
	it("returns [] when no edges match", () => {
		expect(referralsTo(referrals, "p1")).toEqual([]);
	});
});

describe("numberInputValue", () => {
	// Builds the parts of a number input that the function reads, since jsdom does not model badInput.
	const input = (value: string, badInput = false) =>
		({
			value,
			valueAsNumber: value === "" ? Number.NaN : Number(value),
			validity: { badInput },
		}) as HTMLInputElement;

	// Tests that a blank field means no value.
	it("returns null for a blank field", () => {
		expect(numberInputValue(input(""))).toBeNull();
	});

	// Tests that text the browser could not read as a number is NaN, so validation rejects it instead of it counting as blank.
	it("returns NaN when the browser reports bad input", () => {
		expect(numberInputValue(input("", true))).toBeNaN();
	});

	// Tests that the typed number is passed through untouched, so a decimal reaches the whole-number check.
	it.each([
		["12", 12],
		["12.9", 12.9],
		["-3.7", -3.7],
		["0", 0],
	])("returns %j as %d without rounding", (raw, expected) => {
		expect(numberInputValue(input(raw))).toBe(expected);
	});
});
