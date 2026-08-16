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
import caseFormSource from "../src/lib/components/CaseForm.svelte?raw";
import { MAX_MESSAGE_WORDS } from "../src/lib/constants.js";
import { countWords } from "../src/lib/format.js";
import { personaAvailability as clientAvailability } from "../src/lib/student/availability.js";
import { personaAvailability as serverAvailability } from "./lib/turnState.js";
// Source text of the modules whose constants aren't exported, read at build time by Vite's
// ?raw loader -- the alternative (exporting a constant purely so a test can read it) would put
// a test-only seam into production code.
import casesSource from "./services/cases.ts?raw";
import { RUN_LIFETIME_MINUTES } from "./services/simulations.js";
import turnSource from "./services/turn.ts?raw";

function requireMatch(source: string, pattern: RegExp, what: string): string {
	const match = pattern.exec(source);
	if (!match?.[1]) {
		throw new Error(
			`Could not find ${what}. This parity test reads it out of source text, so it needs updating alongside whatever renamed or moved it.`,
		);
	}
	return match[1];
}

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

describe("message word limit: src/lib/constants.ts vs convex/services/turn.ts", () => {
	it("uses the same number on both sides", () => {
		const serverLimit = Number(
			requireMatch(
				turnSource,
				/const MESSAGE_WORDS = (\d+);/,
				"MESSAGE_WORDS in convex/services/turn.ts",
			),
		);
		expect(MAX_MESSAGE_WORDS).toBe(serverLimit);
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

describe("access code format: CaseForm.svelte vs convex/services/cases.ts", () => {
	it("uses the same regex literal on both sides", () => {
		const serverRegex = requireMatch(
			casesSource,
			/const ACCESS_CODE_FORMAT = (\/.+\/);/,
			"ACCESS_CODE_FORMAT in convex/services/cases.ts",
		);
		const clientRegex = requireMatch(
			caseFormSource,
			/const ACCESS_CODE_FORMAT = (\/.+\/);/,
			"ACCESS_CODE_FORMAT in src/lib/components/CaseForm.svelte",
		);
		expect(clientRegex).toBe(serverRegex);
	});
});

describe("simulation duration bound: CaseForm.svelte vs the run lifetime", () => {
	// The client's max and the server's hard cap on how long a run can actually live have to be
	// the same number: a case saved with a longer duration drives a countdown that is still
	// showing time remaining at the moment the run is deleted underneath the student.
	it("bounds the authoring input by exactly the run lifetime", () => {
		const clientMax = Number(
			requireMatch(
				caseFormSource,
				/const MAX_SIMULATION_DURATION = (\d+);/,
				"MAX_SIMULATION_DURATION in src/lib/components/CaseForm.svelte",
			),
		);
		expect(clientMax).toBe(RUN_LIFETIME_MINUTES);
	});

	it("validates against that same bound server-side, not just in the form", () => {
		// The validator has to reference the shared constant rather than re-typing a literal --
		// a hard-coded 120 here would silently drift the next time the lifetime changes.
		expect(casesSource).toContain("duration > RUN_LIFETIME_MINUTES");
	});
});

describe("admin role representation: src/lib/constants.ts vs convex/models/admin.ts", () => {
	// The frontend uses a numeric enum inherited from the old backend; Convex emits string
	// literals. The bridge is a single ternary in AdminAuth.svelte, which silently maps ANY
	// unrecognized role to the lower-privileged ADMIN. That's the safe direction to fail, but it
	// only stays safe while "super" is the exact string the server emits.
	it("bridges exactly the roles the server can emit", async () => {
		const adminModelSource = (await import("../convex/models/admin.ts?raw"))
			.default as string;
		const serverRoles = [
			...adminModelSource.matchAll(/v\.literal\("(\w+)"\)/g),
		].map(([, role]) => role);
		expect(serverRoles.sort()).toEqual(["admin", "super"]);

		const adminAuthSource = (
			await import("../src/lib/components/AdminAuth.svelte?raw")
		).default as string;
		expect(adminAuthSource).toContain('=== "super"');
	});
});
