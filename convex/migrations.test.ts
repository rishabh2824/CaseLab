import { describe, expect, it } from "vitest";
import { isLegacy, reshapeStructure } from "./migrations";

const persona = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: id,
	role: "Role",
	knownFacts: "",
	personalityTraits: "",
	profilePhoto: null,
	availabilityMinutes: null,
	files: [],
	...extra,
});
const referral = (fromId: string, toId: string) => ({
	fromId,
	toId,
	conditions: "",
});

describe("reshapeStructure", () => {
	// Tests that nulls, the stored roots and null file entries are removed while real values stay.
	it("drops nulls and the roots list but keeps real values", () => {
		const photo = { storageId: "s1", fileName: "a.png" };
		const file = { storageId: "s2", fileName: "b.pdf" };
		const legacy = {
			teachingNotes: null,
			structure: {
				personas: [
					persona("A", { profilePhoto: photo, availabilityMinutes: 30 }),
					persona("B", {
						files: [
							{ file: null, shareConditions: "x", perceivedContents: "y" },
							{ file, shareConditions: "x", perceivedContents: "y" },
						],
					}),
				],
				referrals: [referral("A", "B")],
				roots: ["A"],
			},
		};

		const { personas, referrals, ...rest } = reshapeStructure(legacy);

		expect(rest).toEqual({});
		expect(referrals).toEqual([referral("A", "B")]);
		expect(personas[0]).toMatchObject({
			profilePhoto: photo,
			availabilityMinutes: 30,
		});
		expect(personas[1]).not.toHaveProperty("profilePhoto");
		expect(personas[1]).not.toHaveProperty("availabilityMinutes");
		expect(personas[1]!.files).toEqual([
			{ file, shareConditions: "x", perceivedContents: "y" },
		]);
	});

	// Tests that referrals into a stored root are dropped, so the root is not turned into a referred persona.
	it("drops referrals into a root", () => {
		const legacy = {
			structure: {
				personas: [persona("A"), persona("B"), persona("C")],
				referrals: [referral("A", "B"), referral("A", "C")],
				roots: ["A", "B"],
			},
		};

		expect(reshapeStructure(legacy).referrals).toEqual([referral("A", "C")]);
	});
});

describe("isLegacy", () => {
	const clean = {
		structure: {
			personas: [{ ...persona("A"), profilePhoto: undefined }].map(
				({ profilePhoto, availabilityMinutes, ...rest }) => rest,
			) as never,
			referrals: [],
		},
	};

	// Tests that a case with none of the legacy shapes is left alone.
	it("is false for a case without nulls or roots", () => {
		expect(isLegacy(clean)).toBe(false);
	});

	// Tests that each legacy shape on its own marks a case.
	it.each([
		["a stored roots list", { structure: { ...clean.structure, roots: [] } }],
		["a null teachingNotes", { ...clean, teachingNotes: null }],
		[
			"a null profilePhoto",
			{
				structure: {
					...clean.structure,
					personas: [persona("A", { availabilityMinutes: undefined })],
				},
			},
		],
		[
			"a null file entry",
			{
				structure: {
					...clean.structure,
					personas: [
						{
							id: "A",
							files: [{ file: null }],
						},
					],
				},
			},
		],
	])("is true for %s", (_label, legacy) => {
		expect(isLegacy(legacy as never)).toBe(true);
	});
});
