import { describe, expect, it } from "vitest";
import {
	casePath,
	countWords,
	filePath,
	getCaseIssues,
	isSelectableCollaborator,
	MAX_DURATION_MINUTES,
	PERSONAS_PATH,
	personaPath,
	referralPath,
} from "./rules";

const persona = (id: string, name: string) => ({
	id,
	name,
	role: "CFO",
	knownFacts: "Approved the budget.",
	availabilityMinutes: null as number | null,
	files: [] as { file: unknown; shareConditions: string }[],
});

const valid = {
	name: "Sterling",
	brief: "Cut costs.",
	accessCode: "sterling",
	duration: 30 as number | null,
	personas: [persona("a", "Mary Chen"), persona("b", "Priya Nair")],
	referrals: [{ fromId: "a", toId: "b", conditions: "asks about the tender" }],
};

// Returns only the messages for a variation on the valid case.
const messages = (overrides: Partial<typeof valid>): string[] =>
	getCaseIssues({ ...valid, ...overrides }).map((issue) => issue.message);

describe("getCaseIssues", () => {
	// Tests that a complete case has nothing to fix, with or without a time limit.
	it("accepts a complete case, with or without a time limit", () => {
		expect(getCaseIssues(valid)).toEqual([]);
		expect(messages({ duration: null })).toEqual([]);
	});

	// Tests that blank required case fields are reported with their field paths, in field order.
	it("reports blank required case fields in field order", () => {
		expect(
			getCaseIssues({
				...valid,
				name: "  ",
				brief: "",
				accessCode: " ",
			}),
		).toEqual([
			{ path: casePath("name"), message: "Case name is required." },
			{ path: casePath("brief"), message: "Student brief is required." },
			{ path: casePath("accessCode"), message: "Access code is required." },
		]);
	});

	// Tests that an access code must be letters only.
	it.each(["case1", "two words", "case-one", "café", "🙂"])(
		"rejects the access code %s",
		(accessCode) => {
			expect(messages({ accessCode })).toEqual([
				"Access code can only contain letters, with no spaces or numbers.",
			]);
		},
	);

	// Tests that letter case and padding in an access code are ignored, since it is stored lower-cased and trimmed.
	it("accepts an access code in any letter case", () => {
		expect(messages({ accessCode: "  Sterling " })).toEqual([]);
	});

	// Tests that the time limit must be a whole number within the run lifetime.
	it.each([0, -5, 2.5, MAX_DURATION_MINUTES + 1])(
		"rejects a time limit of %s minutes",
		(duration) => {
			expect(messages({ duration })[0]).toContain(
				"whole number of minutes between 1 and 120",
			);
		},
	);

	// Tests that the boundary time limits are accepted.
	it.each([1, MAX_DURATION_MINUTES])(
		"accepts a time limit of %s minutes",
		(duration) => {
			expect(messages({ duration })).toEqual([]);
		},
	);

	// Tests that a case needs a persona, pointing at the button that adds one.
	it("requires at least one persona", () => {
		expect(getCaseIssues({ ...valid, personas: [], referrals: [] })).toEqual([
			{ path: PERSONAS_PATH, message: "Add at least one persona." },
		]);
	});

	// Tests that a blank name and role name the persona by position, and say which persona to open.
	it("names an unnamed persona by its position", () => {
		expect(
			getCaseIssues({
				...valid,
				personas: [
					persona("a", "Mary Chen"),
					{ ...persona("b", " "), role: "" },
				],
			}),
		).toEqual([
			{
				path: personaPath("b", "name"),
				message: "Persona 2: add a name.",
			},
			{
				path: personaPath("b", "role"),
				message: "Persona 2: add a title or role.",
			},
		]);
	});

	// Tests that a persona with no facts is refused, since it can only answer from them.
	it("requires what a persona knows", () => {
		expect(
			getCaseIssues({
				...valid,
				personas: [{ ...persona("a", "Mary Chen"), knownFacts: "  " }],
				referrals: [],
			}),
		).toEqual([
			{
				path: personaPath("a", "knownFacts"),
				message:
					"Add what Mary Chen knows. Personas can only answer from these facts.",
			},
		]);
	});

	// Tests that the availability must be a whole number of at least one minute.
	it.each([0, -1, 1.5, Number.NaN])(
		"rejects an availability of %s minutes",
		(availabilityMinutes) => {
			expect(
				messages({
					personas: [{ ...persona("a", "Mary Chen"), availabilityMinutes }],
					referrals: [],
				}),
			).toEqual([
				"Mary Chen: availability must be a whole number of minutes, at least 1.",
			]);
		},
	);

	// Tests that a referral with no condition is refused and counts against the persona it leads to, because a blank condition is never offered to the model.
	it("requires a condition on every referral", () => {
		expect(
			getCaseIssues({
				...valid,
				referrals: [{ fromId: "a", toId: "b", conditions: " " }],
			}),
		).toEqual([
			{
				path: referralPath("a", "b"),
				message:
					"Add when Mary Chen should refer the student to Priya Nair. Until then, students can't reach Priya Nair.",
			},
		]);
	});

	// Tests that a dead referral is refused even when the persona can be reached another way.
	it("requires a condition even when another referral reaches the persona", () => {
		expect(
			messages({
				personas: [...valid.personas, persona("c", "Dana Ruiz")],
				referrals: [
					...valid.referrals,
					{ fromId: "a", toId: "c", conditions: "asks about the contract" },
					{ fromId: "b", toId: "c", conditions: "" },
				],
			}),
		).toEqual([
			"Add when Priya Nair should refer the student to Dana Ruiz. Until then, students can't reach Dana Ruiz.",
		]);
	});

	// Tests that a file row needs an upload, since a row without one was silently dropped on save.
	it("requires an upload on every file row", () => {
		expect(
			getCaseIssues({
				...valid,
				personas: [
					{
						...persona("a", "Mary Chen"),
						files: [{ file: null, shareConditions: "asks for it" }],
					},
				],
				referrals: [],
			}),
		).toEqual([
			{
				path: filePath("a", 0, "file"),
				message: "Mary Chen, File 1: upload the file or remove this row.",
			},
		]);
	});

	// Tests that a file needs a share condition, because a blank one is never offered to the model.
	it("requires a share condition on every file", () => {
		expect(
			getCaseIssues({
				...valid,
				personas: [
					{
						...persona("a", "Mary Chen"),
						files: [{ file: { fileName: "a.pdf" }, shareConditions: "" }],
					},
				],
				referrals: [],
			}),
		).toEqual([
			{
				path: filePath("a", 0, "shareConditions"),
				message:
					"Mary Chen, File 1: add when Mary Chen should share this file.",
			},
		]);
	});
});

describe("isSelectableCollaborator", () => {
	// Tests that the effective owner is not selectable as their own collaborator.
	it("rejects the effective owner", () => {
		expect(isSelectableCollaborator({ _id: "a" }, "a")).toBe(false);
	});

	// Tests that any other admin is selectable.
	it("accepts another admin", () => {
		expect(isSelectableCollaborator({ _id: "a" }, "b")).toBe(true);
	});
});

describe("countWords", () => {
	// Tests that words are split on tabs, newlines and runs of spaces.
	it("counts words separated by tabs, newlines, and multiple spaces", () => {
		expect(countWords("hello\tworld\n\nfoo   bar")).toBe(4);
	});

	// Tests that blank input has no words.
	it.each(["", "   \n\t  "])("returns 0 for %j", (value) => {
		expect(countWords(value)).toBe(0);
	});

	// Tests that hyphenated words and emoji each count as one word.
	it("counts a hyphenated word as one and an emoji as a word", () => {
		expect(countWords("hyphen-joined stays one")).toBe(3);
		expect(countWords("emoji 🙂 counts")).toBe(3);
	});
});
