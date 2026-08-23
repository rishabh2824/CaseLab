// Node project: pure data-shaping helpers, no DOM required.
import type { GenericId } from "convex/values";
import { describe, expect, it } from "vitest";
import {
	createEmptyPersona,
	createEmptyReferral,
	getPersonaFieldErrors,
	getPersonaLabel,
	hasFieldErrors,
	isRoot,
	normalizePersona,
	normalizeReferral,
	reachableFrom,
	referralsFrom,
	referralsTo,
} from "../../src/lib/case/draft.js";
import { makeReferral } from "../support/fixtures.js";

describe("createEmptyPersona", () => {
	it("assigns each persona a unique id", () => {
		const a = createEmptyPersona();
		const b = createEmptyPersona();
		expect(a.id).not.toBe(b.id);
	});

	it("applies overrides on top of the blank defaults", () => {
		const persona = createEmptyPersona({ name: "Mary", role: "CFO" });
		expect(persona.name).toBe("Mary");
		expect(persona.role).toBe("CFO");
		expect(persona.files).toEqual([]);
	});
});

describe("createEmptyReferral", () => {
	it("returns a blank referral with overrides applied", () => {
		expect(createEmptyReferral()).toEqual({
			from_id: "",
			to_id: "",
			conditions: "",
		});
		expect(createEmptyReferral({ from_id: "p1" }).from_id).toBe("p1");
	});
});

describe("normalizePersona", () => {
	it("normalizes a PersonaPayload-shaped object from the API cleanly", () => {
		// Simulates the API's PersonaPayload: same flat fields as Persona, nothing
		// nested to normalize further (see the comment above normalizePersona).
		const apiPersona = {
			id: "p1",
			name: "Mary",
			role: "CFO",
			profile_photo: null,
			known_facts: "Knows the budget.",
			personality_traits: "Direct.",
			availability_minutes: 30,
			files: [
				{
					file: {
						storage_id: "storage-key" as GenericId<"_storage">,
						file_name: "a.pdf",
					},
				},
			],
		};
		expect(normalizePersona(apiPersona)).toEqual(apiPersona);
	});

	it("produces a valid empty persona for null or undefined", () => {
		const fromNull = normalizePersona(null);
		const fromUndefined = normalizePersona(undefined);
		expect(fromNull.name).toBe("");
		expect(fromNull.files).toEqual([]);
		expect(fromUndefined.name).toBe("");
		expect(fromUndefined.files).toEqual([]);
		// ids are still generated per call, not shared
		expect(fromNull.id).not.toBe(fromUndefined.id);
	});

	it("defaults files to [] when the source persona has no files key", () => {
		const persona = normalizePersona({ id: "p1", name: "Mary" });
		expect(persona.files).toEqual([]);
	});
});

describe("normalizeReferral", () => {
	it("normalizes a partial referral, defaulting missing fields", () => {
		expect(normalizeReferral({ from_id: "p1", to_id: "p2" })).toEqual({
			from_id: "p1",
			to_id: "p2",
			conditions: "",
		});
	});

	it("produces a blank referral for null or undefined", () => {
		expect(normalizeReferral(null)).toEqual({
			from_id: "",
			to_id: "",
			conditions: "",
		});
		expect(normalizeReferral(undefined)).toEqual({
			from_id: "",
			to_id: "",
			conditions: "",
		});
	});
});

describe("getPersonaLabel", () => {
	it("returns the trimmed name when present", () => {
		expect(getPersonaLabel({ name: "  Mary  " }, "fallback")).toBe("Mary");
	});

	it("falls back when the name is whitespace-only", () => {
		// A persona whose name is only spaces must not render as a blank label —
		// this is what lets the UI show "Persona ab12cd" instead of nothing.
		expect(getPersonaLabel({ name: "   " }, "fallback")).toBe("fallback");
	});

	it("falls back when the name is empty", () => {
		expect(getPersonaLabel({ name: "" }, "fallback")).toBe("fallback");
	});
});

describe("getPersonaFieldErrors / hasFieldErrors", () => {
	it("flags a missing name", () => {
		const persona = createEmptyPersona({ name: "  ", role: "CFO" });
		const errors = getPersonaFieldErrors(persona);
		expect(errors.name).toBeTruthy();
		expect(errors.role).toBeUndefined();
		expect(hasFieldErrors(errors)).toBe(true);
	});

	it("flags a missing role", () => {
		const persona = createEmptyPersona({ name: "Mary", role: "" });
		const errors = getPersonaFieldErrors(persona);
		expect(errors.role).toBeTruthy();
		expect(hasFieldErrors(errors)).toBe(true);
	});

	it("has no errors for a fully valid persona", () => {
		const persona = createEmptyPersona({ name: "Mary", role: "CFO" });
		const errors = getPersonaFieldErrors(persona);
		expect(hasFieldErrors(errors)).toBe(false);
	});

	it("treats availability_minutes of 0 as an error", () => {
		const persona = createEmptyPersona({
			name: "Mary",
			role: "CFO",
			availability_minutes: 0,
		});
		expect(getPersonaFieldErrors(persona).availability).toBeTruthy();
	});

	it("treats a negative availability_minutes as an error", () => {
		const persona = createEmptyPersona({
			name: "Mary",
			role: "CFO",
			availability_minutes: -5,
		});
		expect(getPersonaFieldErrors(persona).availability).toBeTruthy();
	});

	it("treats null availability_minutes as valid (unlimited)", () => {
		const persona = createEmptyPersona({
			name: "Mary",
			role: "CFO",
			availability_minutes: null,
		});
		expect(getPersonaFieldErrors(persona).availability).toBeUndefined();
	});

	it("treats exactly 1 as the minimum valid availability_minutes", () => {
		// Boundary check on `< 1`: 1 must NOT be an error, only values below it.
		const persona = createEmptyPersona({
			name: "Mary",
			role: "CFO",
			availability_minutes: 1,
		});
		expect(getPersonaFieldErrors(persona).availability).toBeUndefined();
	});
});

describe("isRoot", () => {
	it("returns true when the id is in the roots list", () => {
		expect(isRoot(["p1", "p2"], "p1")).toBe(true);
	});

	it("returns false when the id is not in the roots list", () => {
		expect(isRoot(["p1", "p2"], "p3")).toBe(false);
	});
});

describe("referralsFrom / referralsTo", () => {
	const referrals = [
		makeReferral("p1", "p2"),
		makeReferral("p1", "p3"),
		makeReferral("p2", "p3"),
	];

	it("referralsFrom returns edges authored by the given persona", () => {
		expect(referralsFrom(referrals, "p1")).toEqual([
			makeReferral("p1", "p2"),
			makeReferral("p1", "p3"),
		]);
	});

	it("referralsTo returns edges pointing at the given persona (possibly multiple parents)", () => {
		expect(referralsTo(referrals, "p3")).toEqual([
			makeReferral("p1", "p3"),
			makeReferral("p2", "p3"),
		]);
	});

	it("returns [] when no edges match", () => {
		expect(referralsFrom(referrals, "p3")).toEqual([]);
		expect(referralsTo(referrals, "p1")).toEqual([]);
	});
});

describe("reachableFrom", () => {
	it("follows a linear chain to its end", () => {
		const referrals = [makeReferral("p1", "p2"), makeReferral("p2", "p3")];
		expect(reachableFrom(["p1"], referrals)).toEqual(
			new Set(["p1", "p2", "p3"]),
		);
	});

	it("keeps a diamond node reachable when only one of its two parents is a start id", () => {
		// p1 -> p2 -> p4, p1 -> p3 -> p4: p4 has two parents (p2, p3). Deleting
		// p2's subtree alone must still find p4 via p3 if p3 is also a start id —
		// this is the case cascade-deletion in the UI relies on to not
		// over-delete a persona reachable some other way.
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

	it("still reaches a diamond node when starting from just one branch", () => {
		const referrals = [makeReferral("p2", "p4"), makeReferral("p3", "p4")];
		// Starting only from p2 (one of p4's two parents) still reaches p4.
		expect(reachableFrom(["p2"], referrals)).toEqual(new Set(["p2", "p4"]));
	});

	it("reaches a node only via the other parent when the first parent is absent", () => {
		const referrals = [makeReferral("p2", "p4"), makeReferral("p3", "p4")];
		expect(reachableFrom(["p3"], referrals)).toEqual(new Set(["p3", "p4"]));
	});

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

	it("returns an empty set for an empty start-id list", () => {
		const referrals = [makeReferral("p1", "p2")];
		expect(reachableFrom([], referrals)).toEqual(new Set());
	});

	it("returns just the start id when it doesn't exist in the referral list", () => {
		const referrals = [makeReferral("p1", "p2")];
		expect(reachableFrom(["nonexistent"], referrals)).toEqual(
			new Set(["nonexistent"]),
		);
	});
});
