// Several rules are deliberately implemented twice -- once in convex/ and once in src/ -- for
// reasons each site documents (a Convex query only re-runs when its DATA changes, never on
// elapsed wall-clock time, so availability has to be recomputed client-side against a ticking
// clock; the word limit is duplicated so the Send button can disable without a round-trip).
// Deliberate duplication is fine. Silent DIVERGENCE is not: the two copies disagreeing produces
// exactly the bugs that are hardest to see, because each side is self-consistent and every
// existing unit test still passes. Nothing else in the suite compares the copies to each other.
//
// These tests are the seam. When a rule legitimately changes, they fail until BOTH copies are
// updated together.
//
// Lives in convex/ rather than tests/ deliberately: it actually imports (not just reads the
// source text of) turnState.ts and services/simulations.ts, and the latter pulls in
// `_generated/api` -- code written for convex's edge-runtime test environment
// (convex/vitest.config.ts), not the node/jsdom projects tests/ runs under.
/// <reference types="vite/client" />

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSelectableCollaborator } from "../src/lib/case/draft.js";
import draftSource from "../src/lib/case/draft.ts?raw";
import { countWords } from "../src/lib/format.js";
import { personaAvailability as clientAvailability } from "../src/lib/student/availability.js";
import { personaAvailability as serverAvailability } from "./lib/turnState.js";
// Source text of the modules whose constants aren't exported, read at build time by Vite's
// ?raw loader -- the alternative (exporting a constant purely so a test can read it) would put
// a test-only seam into production code.
import casesSource from "./services/cases.ts?raw";
import turnSource from "./services/turn.ts?raw";

describe("persona availability: src/lib/student/availability.ts vs convex/lib/turnState.ts", () => {
	// Exhaustive over the interesting integer neighbourhood rather than sampled: the whole
	// function is three branches around two boundaries, so this covers every branch transition
	// including the exact-expiry minute the two copies both special-case.
	it("agrees exactly across every small-integer combination, including the boundaries", () => {
		const durations: (number | null)[] = [null, 0, 1, 2, 5, 30];
		const mismatches: string[] = [];
		for (const duration of durations) {
			for (let availableAt = 0; availableAt <= 8; availableAt++) {
				for (let elapsed = 0; elapsed <= 40; elapsed++) {
					const server = serverAvailability(duration, availableAt, elapsed);
					const client = clientAvailability(duration, availableAt, elapsed);
					if (JSON.stringify(server) !== JSON.stringify(client)) {
						mismatches.push(
							`duration=${duration} availableAt=${availableAt} elapsed=${elapsed}: server=${JSON.stringify(server)} client=${JSON.stringify(client)}`,
						);
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	// And across the ugly inputs the exhaustive sweep above can't reach: negatives (a persona
	// authored with a negative availability window), very large elapsed values, and a run whose
	// clock somehow reads before its own start.
	it("agrees on arbitrary integer inputs, including negative and very large ones", () => {
		fc.assert(
			fc.property(
				fc.option(fc.integer({ min: -1000, max: 100_000 }), { nil: null }),
				fc.integer({ min: -1000, max: 100_000 }),
				fc.integer({ min: -1000, max: 100_000 }),
				(duration, availableAt, elapsed) => {
					expect(clientAvailability(duration, availableAt, elapsed)).toEqual(
						serverAvailability(duration, availableAt, elapsed),
					);
				},
			),
			{ numRuns: 500, seed: 20260816 },
		);
	});

	// Invariants that must hold no matter which copy is asked -- these are what the UI relies
	// on (a countdown must never render a negative number, and "available" must never show a
	// "available in N min" badge alongside it).
	it("never reports a negative countdown, and available always implies availableIn === 0", () => {
		fc.assert(
			fc.property(
				fc.option(fc.integer({ min: 0, max: 500 }), { nil: null }),
				fc.integer({ min: 0, max: 500 }),
				fc.integer({ min: 0, max: 1000 }),
				(duration, availableAt, elapsed) => {
					for (const fn of [clientAvailability, serverAvailability]) {
						const result = fn(duration, availableAt, elapsed);
						expect(result.availableIn ?? 0).toBeGreaterThanOrEqual(0);
						expect(result.expiresIn ?? 0).toBeGreaterThanOrEqual(0);
						if (result.available) expect(result.availableIn).toBe(0);
					}
				},
			),
			{ numRuns: 300, seed: 20260816 },
		);
	});
});

describe("message word limit: convex/schema.ts's MAX_MESSAGE_WORDS", () => {
	// MAX_MESSAGE_WORDS is single-sourced in convex/schema.ts (see RUN_LIFETIME_MINUTES's
	// comment there for why) and imported by both the student composer and startTurn, so
	// there's no second literal left to drift -- only that turn.ts keeps referencing the
	// shared constant rather than a hard-coded 50 that could silently diverge from it.
	it("validates the word count against MAX_MESSAGE_WORDS, not a hard-coded literal", () => {
		expect(turnSource).toContain('from "../schema"');
		expect(turnSource).toContain(".length > MAX_MESSAGE_WORDS");
	});

	// The client disables Send using countWords(); the server rejects using an inline
	// split(/\s+/).filter(Boolean).length. Same intent, two implementations -- so they have to
	// agree on what a "word" is, or a message the button allows gets rejected on arrival.
	it("counts words the same way the server does, for every whitespace shape", () => {
		const serverCount = (message: string) =>
			message.trim().split(/\s+/).filter(Boolean).length;
		const samples = [
			"",
			"   ",
			"one",
			" leading",
			"trailing ",
			"two words",
			"tabs\tand\nnewlines\r\nhere",
			"double  spaced   words",
			"emoji 🙂 counts",
			"hyphen-joined stays one",
			" non-breaking space",
		];
		for (const sample of samples) {
			expect([sample, countWords(sample)]).toEqual([
				sample,
				serverCount(sample),
			]);
		}
	});

	it("agrees on randomly generated whitespace soup", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.constantFrom(" ", "\t", "\n", "\r\n", "  "),
						fc.string({ minLength: 1, maxLength: 6 }),
					),
					{ maxLength: 30 },
				),
				(parts) => {
					const message = parts.join("");
					expect(countWords(message)).toBe(
						message.trim().split(/\s+/).filter(Boolean).length,
					);
				},
			),
			{ numRuns: 300, seed: 20260816 },
		);
	});
});

describe("access code format: src/lib/case/draft.ts's getCaseInfoErrors vs convex/schema.ts", () => {
	// Same shape as the simulation-duration-bound test below: draft.ts's getCaseInfoErrors
	// (called by both CaseInfoFields.svelte, for its own per-field message, and CaseForm.svelte,
	// to decide whether Submit should be disabled -- see its own comment) imports
	// ACCESS_CODE_FORMAT directly from schema.ts rather than declaring a second regex literal,
	// so there's no client/server copy left to drift -- this just pins that it stays an
	// import, not a reintroduced local literal.
	it("imports the shared constant instead of a second literal", () => {
		expect(draftSource).toContain(
			'import { ACCESS_CODE_FORMAT } from "../../../convex/schema.js"',
		);
		expect(draftSource).not.toMatch(/const ACCESS_CODE_FORMAT =/);
	});
});

describe("simulation duration bound: services/cases.ts vs the run lifetime", () => {
	// CaseForm.svelte's own MAX_SIMULATION_DURATION is just RUN_LIFETIME_MINUTES imported
	// (see convex/schema.ts), not a second literal, so there's no client/server drift left to
	// pin here -- only that the server validator keeps referencing the shared constant rather
	// than a hard-coded 120 that could silently drift from it.
	it("validates duration against RUN_LIFETIME_MINUTES, not a hard-coded literal", () => {
		expect(casesSource).toContain("duration > RUN_LIFETIME_MINUTES");
	});
});

describe("collaborator eligibility: src/lib/case/draft.ts's isSelectableCollaborator vs services/cases.ts's resolveCollaboratorIds", () => {
	// resolveCollaboratorIds isn't exported and does real db lookups (get-by-id, role checks
	// against stored admin docs), so it can't be called directly from a pure unit test the way
	// isSelectableCollaborator can. What CAN be pinned without a live db: that the server's
	// rejection is keyed on exactly `role === "super"`, and that the client predicate excludes
	// (never offers as a collaborator candidate) exactly the same role -- so the picker can
	// never offer an admin the server would reject.
	it('the server rejects a collaborator by checking role === "super"', () => {
		expect(casesSource).toContain('admin?.role === "super"');
		expect(casesSource).toContain(
			"Super admins cannot be added as collaborators.",
		);
	});

	it("the client never offers a super admin as a selectable collaborator", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("super", "admin"),
				fc.uuid(),
				fc.option(fc.uuid(), { nil: null }),
				(role, adminId, effectiveOwnerId) => {
					const selectable = isSelectableCollaborator(
						{ _id: adminId, role },
						effectiveOwnerId,
					);
					if (role === "super") expect(selectable).toBe(false);
				},
			),
		);
	});

	// The owner exclusion is the other half of the predicate -- not a server/client parity
	// concern (resolveCollaboratorIds independently rejects the owner appearing in their own
	// collaborator list), but worth pinning here since it's the same function.
	it("the client never offers the effective owner as a selectable collaborator", () => {
		fc.assert(
			fc.property(fc.uuid(), (adminId) => {
				expect(
					isSelectableCollaborator({ _id: adminId, role: "admin" }, adminId),
				).toBe(false);
			}),
		);
	});
});
