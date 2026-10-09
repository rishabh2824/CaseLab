import type { GenericId } from "convex/values";
import { describe, expect, it } from "vitest";
import {
	createEmptyPersona,
	createEmptyReferral,
	getPersonaFieldErrors,
	getPersonaLabel,
	hasFieldErrors,
	normalizePersona,
	normalizeReferral,
	reachableFrom,
	referralsFrom,
	referralsTo,
} from "../../src/lib/case/draft.js";
import { makeReferral } from "../support/fixtures.js";

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

describe("normalizePersona", () => {
	// Tests that normalizePersona passes a full API-shaped persona through unchanged.
	it("normalizes a PersonaPayload-shaped object from the API cleanly", () => {
		const apiPersona = {
			id: "p1",
			name: "Mary",
			role: "CFO",
			profilePhoto: null,
			knownFacts: "Knows the budget.",
			personalityTraits: "Direct.",
			availabilityMinutes: 30,
			files: [
				{
					file: {
						storageId: "storage-key" as GenericId<"_storage">,
						fileName: "a.pdf",
					},
					shareConditions: "When asked about the budget.",
					perceivedContents: "Last quarter budget.",
				},
			],
		};
		expect(normalizePersona(apiPersona)).toEqual(apiPersona);
	});

	// Tests that normalizePersona turns null/undefined into distinct, valid empty personas.
	it("produces a valid empty persona for null or undefined", () => {
		const fromNull = normalizePersona(null);
		const fromUndefined = normalizePersona(undefined);
		expect(fromNull.name).toBe("");
		expect(fromNull.files).toEqual([]);
		expect(fromUndefined.name).toBe("");
		expect(fromUndefined.files).toEqual([]);
		expect(fromNull.id).not.toBe(fromUndefined.id);
	});

	// Tests that normalizePersona defaults files to an empty array when the key is missing.
	it("defaults files to [] when the source persona has no files key", () => {
		const persona = normalizePersona({ id: "p1", name: "Mary" });
		expect(persona.files).toEqual([]);
	});
});

describe("normalizeReferral", () => {
	// Tests that normalizeReferral fills in defaults for the fields a partial referral lacks.
	it("normalizes a partial referral, defaulting missing fields", () => {
		expect(normalizeReferral({ fromId: "p1", toId: "p2" })).toEqual({
			fromId: "p1",
			toId: "p2",
			conditions: "",
		});
	});

	// Tests that normalizeReferral returns a blank referral for null/undefined.
	it("produces a blank referral for null or undefined", () => {
		expect(normalizeReferral(null)).toEqual({
			fromId: "",
			toId: "",
			conditions: "",
		});
		expect(normalizeReferral(undefined)).toEqual({
			fromId: "",
			toId: "",
			conditions: "",
		});
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

describe("getPersonaFieldErrors / hasFieldErrors", () => {
	// Tests that a blank persona name is reported as a field error.
	it("flags a missing name", () => {
		const persona = createEmptyPersona({ name: "  ", role: "CFO" });
		const errors = getPersonaFieldErrors(persona);
		expect(errors.name).toBeTruthy();
		expect(errors.role).toBeUndefined();
		expect(hasFieldErrors(errors)).toBe(true);
	});

	// Tests that a blank persona role is reported as a field error.
	it("flags a missing role", () => {
		const persona = createEmptyPersona({ name: "Mary", role: "" });
		const errors = getPersonaFieldErrors(persona);
		expect(errors.role).toBeTruthy();
		expect(hasFieldErrors(errors)).toBe(true);
	});

	// Tests that a valid persona produces no field errors.
	it("has no errors for a fully valid persona", () => {
		const persona = createEmptyPersona({ name: "Mary", role: "CFO" });
		const errors = getPersonaFieldErrors(persona);
		expect(hasFieldErrors(errors)).toBe(false);
	});

	// Tests that availabilityMinutes of 0 is rejected.
	it("treats availabilityMinutes of 0 as an error", () => {
		const persona = createEmptyPersona({
			name: "Mary",
			role: "CFO",
			availabilityMinutes: 0,
		});
		expect(getPersonaFieldErrors(persona).availability).toBeTruthy();
	});

	// Tests that a negative availabilityMinutes is rejected.
	it("treats a negative availabilityMinutes as an error", () => {
		const persona = createEmptyPersona({
			name: "Mary",
			role: "CFO",
			availabilityMinutes: -5,
		});
		expect(getPersonaFieldErrors(persona).availability).toBeTruthy();
	});

	// Tests that a null availabilityMinutes (unlimited) is accepted.
	it("treats null availabilityMinutes as valid (unlimited)", () => {
		const persona = createEmptyPersona({
			name: "Mary",
			role: "CFO",
			availabilityMinutes: null,
		});
		expect(getPersonaFieldErrors(persona).availability).toBeUndefined();
	});

	// Tests that 1 is the smallest availabilityMinutes that validates.
	it("treats exactly 1 as the minimum valid availabilityMinutes", () => {
		const persona = createEmptyPersona({
			name: "Mary",
			role: "CFO",
			availabilityMinutes: 1,
		});
		expect(getPersonaFieldErrors(persona).availability).toBeUndefined();
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

describe("reachableFrom", () => {
	// Tests that reachableFrom follows a linear chain to its end.
	it("follows a linear chain to its end", () => {
		const referrals = [makeReferral("p1", "p2"), makeReferral("p2", "p3")];
		expect(reachableFrom(["p1"], referrals)).toEqual(
			new Set(["p1", "p2", "p3"]),
		);
	});

	// Tests that a diamond-join node stays reachable when starting from the shared ancestor.
	it("keeps a diamond node reachable when only one of its two parents is a start id", () => {
		const referrals = [
			makeReferral("p1", "p2"),
			makeReferral("p1", "p3"),
			makeReferral("p2", "p4"),
			makeReferral("p3", "p4"),
		];
		expect(reachableFrom(["p1"], referrals)).toEqual(
			new Set(["p1", "p2", "p3", "p4"]),
		);
	});

	// Tests that a diamond-join node is reachable when starting from only one of its parents.
	it("still reaches a diamond node when starting from just one branch", () => {
		const referrals = [makeReferral("p2", "p4"), makeReferral("p3", "p4")];
		expect(reachableFrom(["p2"], referrals)).toEqual(new Set(["p2", "p4"]));
	});

	// Tests that a diamond-join node is reachable through the other parent when the first is not a start.
	it("reaches a node only via the other parent when the first parent is absent", () => {
		const referrals = [makeReferral("p2", "p4"), makeReferral("p3", "p4")];
		expect(reachableFrom(["p3"], referrals)).toEqual(new Set(["p3", "p4"]));
	});

	// Tests that reachableFrom terminates on a cyclic referral graph.
	it("terminates on a cycle instead of looping forever", () => {
		const referrals = [
			makeReferral("p1", "p2"),
			makeReferral("p2", "p3"),
			makeReferral("p3", "p1"),
		];
		expect(reachableFrom(["p1"], referrals)).toEqual(
			new Set(["p1", "p2", "p3"]),
		);
	});

	// Tests that reachableFrom returns an empty set when there are no start ids.
	it("returns an empty set for an empty start-id list", () => {
		const referrals = [makeReferral("p1", "p2")];
		expect(reachableFrom([], referrals)).toEqual(new Set());
	});

	// Tests that reachableFrom returns just the start id when it has no referrals.
	it("returns just the start id when it doesn't exist in the referral list", () => {
		const referrals = [makeReferral("p1", "p2")];
		expect(reachableFrom(["nonexistent"], referrals)).toEqual(
			new Set(["nonexistent"]),
		);
	});
});
