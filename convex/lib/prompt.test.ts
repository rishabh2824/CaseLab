import { describe, expect, it } from "vitest";
import type { PersonaDetail } from "../services/simulationReads";
import {
	systemPrompt as buildSystemPrompt,
	cleanReply,
	coerceHandles,
	parseReply,
} from "./prompt";

// Calls the real system prompt builder and joins its stable and dynamic parts into one string.
function systemPrompt(...args: Parameters<typeof buildSystemPrompt>): string {
	const { stable, dynamic } = buildSystemPrompt(...args);
	return `${stable}\n\n${dynamic}`;
}

// Builds a persona detail with defaults and optional overrides.
function personaDetail(overrides: Partial<PersonaDetail> = {}): PersonaDetail {
	return {
		id: "A",
		name: "Mary",
		role: "CFO",
		profilePhoto: null,
		profilePhotoUrl: null,
		availabilityDuration: null,
		knownFacts: "Karen handles all complaint escalations.",
		personalityTraits: "Direct, impatient",
		files: [],
		isReferred: false,
		...overrides,
	};
}

const BRIEF = "Reduce office supply costs.";
const COMMON_INFO = "Sterling Industries background.";

describe("systemPrompt", () => {
	// Tests that the system prompt carries the case and persona facts.
	it("returns a string carrying case and persona facts", () => {
		const prompt = systemPrompt(BRIEF, COMMON_INFO, personaDetail(), [], []);
		expect(prompt).toContain(BRIEF);
		expect(prompt).toContain(COMMON_INFO);
		expect(prompt).toContain("Mary");
		expect(prompt).toContain("CFO");
		expect(prompt).toContain("Direct, impatient");
		expect(prompt).toContain("Karen handles all complaint escalations.");
	});

	// Tests that referral and file candidates are listed with their handles and conditions.
	it("lists referral and file candidates with their handles and conditions", () => {
		const prompt = systemPrompt(
			BRIEF,
			COMMON_INFO,
			personaDetail(),
			[
				{
					handle: "R1",
					name: "Bob",
					role: "COO",
					conditionTrigger: "the user asks for the COO",
				},
			],
			[
				{
					handle: "F1",
					name: "Budget.pdf",
					perceivedContents: "last quarter's numbers",
					shareConditions: "the user asks about the budget",
				},
			],
		);
		expect(prompt).toContain("Referrals:");
		expect(prompt).toContain("Files:");
		expect(prompt).toContain("R1: Bob (COO)");
		expect(prompt).toContain("unlock condition: the user asks for the COO");
		expect(prompt).toContain(
			"F1: Budget.pdf (what you believe it contains: last quarter's numbers)",
		);
		expect(prompt).toContain(
			"sharing condition: the user asks about the budget",
		);
	});

	// Tests that every referral candidate's handle appears in the prompt.
	it("lists every referral candidate's handle", () => {
		const prompt = systemPrompt(
			BRIEF,
			COMMON_INFO,
			personaDetail(),
			[
				{ handle: "R1", name: "Bob", role: "COO", conditionTrigger: "cond 1" },
				{ handle: "R2", name: "Sue", role: "CTO", conditionTrigger: "cond 2" },
			],
			[],
		);
		expect(prompt).toContain("You may introduce a contact");
		expect(prompt).toContain("R1: Bob (COO)");
		expect(prompt).toContain("R2: Sue (CTO)");
	});

	// Tests that the prompt takes the no-referrals branch when there are no candidates.
	it("takes the no-referrals branch when there are no candidates", () => {
		const prompt = systemPrompt(BRIEF, COMMON_INFO, personaDetail(), [], []);
		expect(prompt).toContain("You have no one to introduce this turn.");
		expect(prompt).not.toContain("You may introduce a contact");
	});

	// Tests that the parenthetical is omitted for a file with no perceived contents.
	it("omits the parenthetical when a file has no perceived contents", () => {
		const prompt = systemPrompt(
			BRIEF,
			COMMON_INFO,
			personaDetail(),
			[],
			[
				{
					handle: "F2",
					name: "Empty.pdf",
					perceivedContents: "",
					shareConditions: "the user asks",
				},
			],
		);
		expect(prompt).toContain("F2: Empty.pdf");
		expect(prompt).not.toContain("F2: Empty.pdf (what you believe");
	});

	// Tests that the prompt takes the no-files branch when there are no candidates.
	it("takes the no-files branch when there are no candidates", () => {
		const prompt = systemPrompt(BRIEF, COMMON_INFO, personaDetail(), [], []);
		expect(prompt).toContain("You have no file to send this turn.");
		expect(prompt).not.toContain("You may send a file");
	});

	// Tests that the never-introduce-anyone-unlisted sentence is added whenever there are referral candidates.
	it("adds the never-introduce-anyone-unlisted sentence whenever there are referral candidates", () => {
		const prompt = systemPrompt(
			BRIEF,
			COMMON_INFO,
			personaDetail(),
			[
				{
					handle: "R1",
					name: "Karen",
					role: "Support Lead",
					conditionTrigger: "cond",
				},
			],
			[],
		);
		expect(prompt).toContain(
			"Never introduce, mention, hint at, or offer to connect the user",
		);
	});

	describe("redaction (security-critical)", () => {
		// Tests that a candidate referral's name is redacted from known facts regardless of its condition.
		it("redacts a candidate referral's name out of known facts, regardless of its condition", () => {
			const prompt = systemPrompt(
				BRIEF,
				COMMON_INFO,
				personaDetail({
					knownFacts: "Karen handles all complaint escalations.",
				}),
				[
					{
						handle: "R1",
						name: "Karen",
						role: "Support Lead",
						conditionTrigger: "the user asks for support",
					},
				],
				[],
			);
			expect(prompt).not.toContain("Karen handles all complaint escalations.");
			expect(prompt).toContain("[undisclosed contact]");
			expect(prompt).toContain("R1: Karen (Support Lead)");
		});

		// Tests that redaction matches whole words only, not substrings of a longer name.
		it("only matches whole words, not substrings of a longer name", () => {
			const prompt = systemPrompt(
				BRIEF,
				COMMON_INFO,
				personaDetail({ knownFacts: "Anna is the CFO." }),
				[
					{
						handle: "R1",
						name: "Ann",
						role: "Analyst",
						conditionTrigger: "cond",
					},
				],
				[],
			);
			expect(prompt).toContain("Anna is the CFO.");
			expect(prompt).not.toContain("[undisclosed contact]");
		});

		// Tests that regex metacharacters in a candidate name are escaped rather than crashing or over-matching.
		it("escapes regex metacharacters in the candidate name instead of crashing or over-matching", () => {
			const prompt = systemPrompt(
				BRIEF,
				COMMON_INFO,
				personaDetail({ knownFacts: "Reach out to J. Smith for approvals." }),
				[
					{
						handle: "R1",
						name: "J. Smith",
						role: "Approver",
						conditionTrigger: "cond",
					},
				],
				[],
			);
			expect(prompt).not.toContain("Reach out to J. Smith for approvals.");
			expect(prompt).toContain(
				"Reach out to [undisclosed contact] for approvals.",
			);
		});

		// Tests that names ending in non-ASCII letters or a period are still redacted.
		it.each([
			["Zoë", "Ask Zoë about the budget."],
			["José", "José signs off on spend."],
			["Chen Jr.", "Chen Jr. approves refunds."],
		])("redacts %s despite a non-word boundary character", (name, facts) => {
			const prompt = systemPrompt(
				BRIEF,
				COMMON_INFO,
				personaDetail({ knownFacts: facts }),
				[{ handle: "R1", name, role: "Lead", conditionTrigger: "cond" }],
				[],
			);
			const line = prompt
				.split("\n")
				.find((l) => l.startsWith("Persona information:"));
			expect(line).toContain("[undisclosed contact]");
			expect(line).not.toContain(name);
		});

		// Tests that a name inside a longer non-ASCII word is left alone.
		it("does not redact a name embedded in a longer accented word", () => {
			const prompt = systemPrompt(
				BRIEF,
				COMMON_INFO,
				personaDetail({ knownFacts: "Renée works on Renéeland." }),
				[
					{
						handle: "R1",
						name: "René",
						role: "Analyst",
						conditionTrigger: "cond",
					},
				],
				[],
			);
			expect(prompt).toContain("Renée works on Renéeland.");
		});

		// Tests that every occurrence is redacted, including next to punctuation, and each candidate in turn.
		it("redacts every occurrence and every candidate", () => {
			const prompt = systemPrompt(
				BRIEF,
				COMMON_INFO,
				personaDetail({
					knownFacts: "Karen, (Dave) and Karen's boss Dave: Karen.",
				}),
				[
					{ handle: "R1", name: "Karen", role: "Lead", conditionTrigger: "c" },
					{ handle: "R2", name: "Dave", role: "Boss", conditionTrigger: "c" },
				],
				[],
			);
			expect(prompt).toContain(
				"Persona information: [undisclosed contact], ([undisclosed contact]) and [undisclosed contact]'s boss [undisclosed contact]: [undisclosed contact].",
			);
		});

		// Tests that a blank candidate name is skipped without error while a real one is still redacted.
		it("skips a blank/whitespace candidate name without erroring, and still redacts a real one", () => {
			const prompt = systemPrompt(
				BRIEF,
				COMMON_INFO,
				personaDetail({
					knownFacts: "Karen handles all complaint escalations.",
				}),
				[
					{ handle: "R1", name: "", role: "Unknown", conditionTrigger: "cond" },
					{
						handle: "R2",
						name: "Karen",
						role: "Support Lead",
						conditionTrigger: "cond",
					},
				],
				[],
			);
			expect(prompt).toContain("[undisclosed contact]");
		});
	});
});

describe("parseReply", () => {
	// Tests that parseReply parses a clean JSON object.
	it("parses a clean JSON object", () => {
		const raw = '{"reply": "Hi there.", "introduce": ["R1"], "send_files": []}';
		expect(parseReply(raw)).toEqual({
			reply: "Hi there.",
			introduce: ["R1"],
			send_files: [],
		});
	});

	// Tests that parseReply returns null for empty or missing input.
	it("returns null for empty or missing input", () => {
		expect(parseReply("")).toBeNull();
		expect(parseReply(undefined)).toBeNull();
		expect(parseReply(null)).toBeNull();
	});

	// Tests that parseReply returns null for unparseable text.
	it("returns null for unparseable text", () => {
		expect(parseReply("not json at all")).toBeNull();
	});

	// Tests that parseReply returns null for a JSON array.
	it("returns null for a JSON array (not an object)", () => {
		expect(parseReply("[1, 2, 3]")).toBeNull();
	});
});

describe("coerceHandles", () => {
	// Tests that coerceHandles upper-cases and strips entries.
	it("upper-cases and strips entries", () => {
		expect(coerceHandles(["r1", " R2 "])).toEqual(["R1", "R2"]);
	});

	// Tests that coerceHandles drops whitespace-only entries.
	it("drops whitespace-only entries", () => {
		expect(coerceHandles(["   ", "r1"])).toEqual(["R1"]);
	});

	// Tests that coerceHandles treats a bare string as a single-item list.
	it("treats a bare string as a single-item list", () => {
		expect(coerceHandles("R1")).toEqual(["R1"]);
	});

	// Tests that coerceHandles returns an empty list for non-list, non-string input.
	it("returns empty for non-list, non-string input", () => {
		expect(coerceHandles(5)).toEqual([]);
		expect(coerceHandles(null)).toEqual([]);
	});

	// Tests that coerceHandles skips items that are neither strings nor numbers.
	it("skips items that are neither strings nor numbers", () => {
		expect(coerceHandles(["R1", null, ["nested"], 2])).toEqual(["R1", "2"]);
	});
});

describe("cleanReply", () => {
	// Tests that cleanReply strips a leading speaker tag.
	it("strips a leading speaker tag", () => {
		expect(cleanReply("[Mary, CFO] Hello there.")).toBe("Hello there.");
	});

	// Tests that cleanReply leaves an inline bracket untouched.
	it("leaves an inline bracket untouched", () => {
		const text = "Sure thing. [Note: confidential] Okay.";
		expect(cleanReply(text)).toBe(text);
	});

	// Tests that cleanReply handles empty and missing input.
	it("handles empty and missing input", () => {
		expect(cleanReply(null)).toBe("");
		expect(cleanReply(undefined)).toBe("");
		expect(cleanReply("")).toBe("");
		expect(cleanReply("   ")).toBe("");
	});
});
