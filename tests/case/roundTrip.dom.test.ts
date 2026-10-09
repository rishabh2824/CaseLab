import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import { parseHTMLForm } from "../../src/lib/case/importCase.js";
import type { Persona, ReferralEdge } from "../../src/lib/types.js";

const FC_CONFIG = { numRuns: 50, seed: 20260803 };

const textArb = fc.oneof(
	fc.string({ maxLength: 24 }),
	fc.string({ unit: "grapheme-composite", maxLength: 12 }),
	fc.constantFrom(
		"<script>alert(1)</script>",
		"<b>bold</b> & <i>italic</i>",
		'She said "hello" & waved',
		"Tom & Jerry's Café",
		"line one\nline two",
		"  padded on both sides  ",
		"café — déjà vu 😀",
		"O'Brien <3",
	),
);

const availabilityArb = fc.option(fc.integer({ min: -10, max: 999 }), {
	nil: null,
});

const filesArb = fc.oneof(
	fc.constant<Persona["files"]>([]),
	fc
		.array(
			fc.record({
				shareConditions: textArb,
				perceivedContents: textArb,
			}),
			{ minLength: 1, maxLength: 5 },
		)
		.map((entries) => entries as Persona["files"]),
);

const personaFieldsArb = fc.record({
	name: textArb,
	role: textArb,
	knownFacts: textArb,
	personalityTraits: textArb,
	availabilityMinutes: availabilityArb,
	files: filesArb,
});

type GeneratedCase = {
	caseName: string;
	accessCode: string;
	simulationDurationMinutes: number | null;
	initialBrief: string;
	commonInformation: string;
	personas: Array<Persona & { knownFacts: string; personalityTraits: string }>;
	referrals: ReferralEdge[];
	roots: string[];
};

const caseArb: fc.Arbitrary<GeneratedCase> = fc
	.integer({ min: 1, max: 6 })
	.chain((n) => {
		const ids = Array.from({ length: n }, (_, i) => `P${i}`);
		const spanningParents =
			n === 1
				? fc.constant<number[]>([])
				: fc.tuple(
						...Array.from({ length: n - 1 }, (_, i) => fc.nat({ max: i })),
					);
		const extraCandidates: Array<[number, number]> = [];
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) extraCandidates.push([i, j]);
		}
		return fc
			.tuple(
				fc.array(personaFieldsArb, { minLength: n, maxLength: n }),
				spanningParents,
				fc.array(fc.boolean(), {
					minLength: extraCandidates.length,
					maxLength: extraCandidates.length,
				}),
				fc.array(textArb, { minLength: n, maxLength: n }),
				textArb,
				textArb,
				textArb,
				textArb,
				fc.option(fc.integer({ min: 0, max: 600 }), { nil: null }),
				fc.array(fc.boolean(), {
					minLength: Math.max(n - 1, 0),
					maxLength: Math.max(n - 1, 0),
				}),
			)
			.map(
				([
					personaFields,
					parents,
					extraFlags,
					conditionTexts,
					caseName,
					accessCode,
					initialBrief,
					commonInformation,
					simulationDurationMinutes,
					extraRootFlags,
				]) => {
					const personas: Array<
						Persona & { knownFacts: string; personalityTraits: string }
					> = personaFields.map((fields, i) => ({
						id: ids[i] as string,
						name: fields.name,
						role: fields.role,
						profilePhoto: null,
						knownFacts: fields.knownFacts,
						personalityTraits: fields.personalityTraits,
						availabilityMinutes: fields.availabilityMinutes,
						files: fields.files,
					}));

					const seen = new Set<string>();
					const referrals: ReferralEdge[] = [];
					const addEdge = (from: number, to: number, conditionIdx: number) => {
						const key = `${from}-${to}`;
						if (seen.has(key)) return;
						seen.add(key);
						referrals.push({
							fromId: ids[from] as string,
							toId: ids[to] as string,
							conditions: conditionTexts[conditionIdx] as string,
						});
					};
					parents.forEach((parent, idx) => {
						addEdge(parent, idx + 1, idx);
					});
					extraCandidates.forEach(([i, j], k) => {
						if (extraFlags[k]) addEdge(i, j, k % n);
					});

					const roots = [
						ids[0] as string,
						...ids.slice(1).filter((_, i) => extraRootFlags[i]),
					];

					return {
						caseName,
						accessCode,
						simulationDurationMinutes,
						initialBrief,
						commonInformation,
						personas,
						referrals,
						roots,
					};
				},
			);
	});

// Builds a comparable key for a referral from its ends and trimmed conditions.
const edgeKey = (e: ReferralEdge) =>
	`${e.fromId}->${e.toId}::${(e.conditions ?? "").trim()}`;

describe("buildHTMLForm / parseHTMLForm round trip", () => {
	// Tests that exporting then importing a case reproduces the same personas, referrals and roots without warnings.
	it("reconstructs the same personas, referrals, and roots with no warnings", () => {
		fc.assert(
			fc.property(caseArb, (generated) => {
				const html = buildHTMLForm(generated);
				const { data, warnings } = parseHTMLForm(html);

				expect(warnings).toEqual([]);

				expect(data.caseName).toBe(generated.caseName.trim());
				expect(data.accessCode).toBe(generated.accessCode.trim());
				expect(data.initialBrief).toBe(generated.initialBrief.trim());
				expect(data.commonInformation).toBe(generated.commonInformation.trim());
				expect(data.simulationDurationMinutes).toBe(
					generated.simulationDurationMinutes,
				);

				expect(data.personas).toHaveLength(generated.personas.length);
				const idMap = new Map(
					generated.personas.map((original, i) => [
						original.id,
						data.personas[i]?.id,
					]),
				);
				expect(data.roots).toEqual(generated.roots.map((id) => idMap.get(id)));
				for (const [imported, original] of zip(
					data.personas,
					generated.personas,
				)) {
					expect(imported.name).toBe(original.name.trim());
					expect(imported.role).toBe(original.role.trim());
					expect(imported.knownFacts).toBe(original.knownFacts.trim());
					expect(imported.personalityTraits).toBe(
						original.personalityTraits.trim(),
					);
					expect(imported.availabilityMinutes).toBe(
						original.availabilityMinutes,
					);
					expect(imported.files).toEqual(
						original.files.map((file) => ({
							file: null,
							shareConditions: (file.shareConditions ?? "").trim(),
							perceivedContents: (file.perceivedContents ?? "").trim(),
						})),
					);
				}

				const importedEdgeKeys = data.referrals.map(edgeKey).sort();
				const originalEdgeKeys = generated.referrals
					.map((edge) =>
						edgeKey({
							fromId: idMap.get(edge.fromId) as string,
							toId: idMap.get(edge.toId) as string,
							conditions: edge.conditions,
						}),
					)
					.sort();
				expect(importedEdgeKeys).toEqual(originalEdgeKeys);
			}),
			FC_CONFIG,
		);
	});
});

// Yields pairs of items from two arrays, stopping at the shorter one.
function* zip<A, B>(a: A[], b: B[]): Generator<[A, B]> {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) yield [a[i] as A, b[i] as B];
}
