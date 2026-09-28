/// <reference types="vite/client" />

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSelectableCollaborator } from "../src/lib/case/draft.js";
import draftSource from "../src/lib/case/draft.ts?raw";
import { countWords } from "../src/lib/format.js";
import { personaAvailability as clientAvailability } from "../src/lib/student/availability.js";
import { personaAvailability as serverAvailability } from "./lib/turnState.js";
import casesSource from "./services/cases.ts?raw";
import turnSource from "./services/turn.ts?raw";

describe("persona availability: src/lib/student/availability.ts vs convex/lib/turnState.ts", () => {
	// Tests that the client and server persona availability logic agree on every small-integer combination.
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

	// Tests that the client and server availability logic agree on arbitrary integers, including negative and huge ones.
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

	// Tests that the countdown is never negative and available always implies availableIn is 0.
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
	// Tests that the server's message word limit uses MAX_MESSAGE_WORDS rather than a hard-coded literal.
	it("validates the word count against MAX_MESSAGE_WORDS, not a hard-coded literal", () => {
		expect(turnSource).toContain('from "../schema"');
		expect(turnSource).toContain(".length > MAX_MESSAGE_WORDS");
	});

	// Tests that the client and server count words identically for every whitespace shape.
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

	// Tests that the client and server word counts agree on randomly generated whitespace.
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
	// Tests that the client imports the shared ACCESS_CODE_FORMAT instead of defining a second literal.
	it("imports the shared constant instead of a second literal", () => {
		expect(draftSource).toContain(
			'import { ACCESS_CODE_FORMAT } from "../../../convex/schema.js"',
		);
		expect(draftSource).not.toMatch(/const ACCESS_CODE_FORMAT =/);
	});
});

describe("simulation duration bound: services/cases.ts vs the run lifetime", () => {
	// Tests that case duration validation uses RUN_LIFETIME_MINUTES rather than a hard-coded literal.
	it("validates duration against RUN_LIFETIME_MINUTES, not a hard-coded literal", () => {
		expect(casesSource).toContain("duration > RUN_LIFETIME_MINUTES");
	});
});

describe("collaborator eligibility: src/lib/case/draft.ts's isSelectableCollaborator vs services/cases.ts's resolveCollaboratorIds", () => {
	// Tests that the server rejects a collaborator by checking role === "super".
	it('the server rejects a collaborator by checking role === "super"', () => {
		expect(casesSource).toContain('admin?.role === "super"');
		expect(casesSource).toContain(
			"Super admins cannot be added as collaborators.",
		);
	});

	// Tests that the client never offers a super admin as a selectable collaborator.
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

	// Tests that the client never offers the effective owner as a selectable collaborator.
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
