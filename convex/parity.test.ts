/// <reference types="vite/client" />

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSelectableCollaborator } from "../src/lib/case/draft.js";
import { countWords } from "../src/lib/format.js";
import casesSource from "./services/cases.ts?raw";
import turnSource from "./turn.ts?raw";

describe("message word limit: convex/lib/constants.ts's MAX_MESSAGE_WORDS", () => {
	// Tests that the server's message word limit uses MAX_MESSAGE_WORDS rather than a hard-coded literal.
	it("validates the word count against MAX_MESSAGE_WORDS, not a hard-coded literal", () => {
		expect(turnSource).toContain('from "./lib/constants"');
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
