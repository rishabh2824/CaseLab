import { describe, expect, it } from "vitest";
import type { PersonaDetail } from "../services/simulationReads";
import { cleanReply, coerceHandles, parseReply, systemPrompt } from "./prompt";

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
	it("returns a string carrying case and persona facts", () => {
		const prompt = systemPrompt(BRIEF, COMMON_INFO, personaDetail(), [], []);
		expect(prompt).toContain(BRIEF);
		expect(prompt).toContain(COMMON_INFO);
		expect(prompt).toContain("Mary");
		expect(prompt).toContain("CFO");
		expect(prompt).toContain("Direct, impatient");
		expect(prompt).toContain("Karen handles all complaint escalations.");
	});

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

	it("takes the no-referrals branch when there are no candidates", () => {
		const prompt = systemPrompt(BRIEF, COMMON_INFO, personaDetail(), [], []);
		expect(prompt).toContain("You have no one to introduce this turn.");
		expect(prompt).not.toContain("You may introduce a contact");
	});

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

	it("takes the no-files branch when there are no candidates", () => {
		const prompt = systemPrompt(BRIEF, COMMON_INFO, personaDetail(), [], []);
		expect(prompt).toContain("You have no file to send this turn.");
		expect(prompt).not.toContain("You may send a file");
	});

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
			// The name still appears in the Referrals: candidate list itself -- only the
			// incidental knownFacts mention is redacted.
			expect(prompt).toContain("R1: Karen (Support Lead)");
		});

		it("only matches whole words, not substrings of a longer name", () => {
			// "Ann" is a substring of "Anna" -- must not redact into the middle of it.
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
	it("parses a clean JSON object", () => {
		const raw = '{"reply": "Hi there.", "introduce": ["R1"], "send_files": []}';
		expect(parseReply(raw)).toEqual({
			reply: "Hi there.",
			introduce: ["R1"],
			send_files: [],
		});
	});

	it("returns null for empty or missing input", () => {
		expect(parseReply("")).toBeNull();
		expect(parseReply(undefined)).toBeNull();
		expect(parseReply(null)).toBeNull();
	});

	it("returns null for unparseable text", () => {
		expect(parseReply("not json at all")).toBeNull();
	});

	it("returns null for a JSON array (not an object)", () => {
		expect(parseReply("[1, 2, 3]")).toBeNull();
	});
});

describe("coerceHandles", () => {
	it("upper-cases and strips entries", () => {
		expect(coerceHandles(["r1", " R2 "])).toEqual(["R1", "R2"]);
	});

	it("drops whitespace-only entries", () => {
		expect(coerceHandles(["   ", "r1"])).toEqual(["R1"]);
	});

	it("treats a bare string as a single-item list", () => {
		expect(coerceHandles("R1")).toEqual(["R1"]);
	});

	it("returns empty for non-list, non-string input", () => {
		expect(coerceHandles(5)).toEqual([]);
		expect(coerceHandles(null)).toEqual([]);
	});

	it("skips items that are neither strings nor numbers", () => {
		expect(coerceHandles(["R1", null, ["nested"], 2])).toEqual(["R1", "2"]);
	});
});

describe("cleanReply", () => {
	it("strips a leading speaker tag", () => {
		expect(cleanReply("[Mary, CFO] Hello there.")).toBe("Hello there.");
	});

	it("leaves an inline bracket untouched", () => {
		const text = "Sure thing. [Note: confidential] Okay.";
		expect(cleanReply(text)).toBe(text);
	});

	it("handles empty and missing input", () => {
		expect(cleanReply(null)).toBe("");
		expect(cleanReply(undefined)).toBe("");
		expect(cleanReply("")).toBe("");
		expect(cleanReply("   ")).toBe("");
	});
});
