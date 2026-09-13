// Client project: exercises buildHTMLForm + parseHTMLForm together, both of
// which need a real DOMParser.
//
// buildHTMLForm (512 lines) and parseHTMLForm (284 lines) are meant to be
// inverses: an admin exports a scaffold, an AI (or a human) fills it in, and
// re-importing it must reconstruct the same case. Nothing else in the suite
// checks that the two files actually agree with each other — this file's job
// is exactly that, via a property generated over many arbitrary cases rather
// than a handful of examples.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildHTMLForm } from "../../src/lib/case/exportCase.js";
import { parseHTMLForm } from "../../src/lib/case/importCase.js";
import type { Persona, ReferralEdge } from "../../src/lib/types.js";

// A fixed seed makes a shrunk failure reproducible: re-running the suite
// after a code change will explore the exact same case space.
const FC_CONFIG = { numRuns: 50, seed: 20260803 };

// Text arbitrary mixing plain strings, unicode (CJK/emoji via
// grapheme-composite), and a curated set of values known to be
// historically tricky for HTML round-tripping: markup, entities, quotes,
// embedded newlines, and leading/trailing whitespace (all of which the
// importer trims away — see the `.trim()` normalization below).
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

// Each file entry round-trips as a positional placeholder — share_conditions
// and perceived_contents survive, `file` itself never does (there's no way to
// carry a real attachment through a text form; see fileRowMarkup in
// exportCase.ts). Generating real text here (not just presence/absence) is
// what proves the two describing fields actually make the trip intact.
const filesArb = fc.oneof(
	fc.constant<Persona["files"]>([]),
	fc
		.array(
			fc.record({
				share_conditions: textArb,
				perceived_contents: textArb,
			}),
			{ minLength: 1, maxLength: 5 },
		)
		.map((entries) => entries as Persona["files"]),
);

const personaFieldsArb = fc.record({
	name: textArb,
	role: textArb,
	known_facts: textArb,
	personality_traits: textArb,
	availability_minutes: availabilityArb,
	files: filesArb,
});

type GeneratedCase = {
	caseName: string;
	accessCode: string;
	simulationDurationMinutes: number | null;
	initialBrief: string;
	commonInformation: string;
	// known_facts/personality_traits are optional+nullable on Persona in
	// general, but personaFieldsArb (via textArb) always supplies a plain
	// string for them — narrowed here so the round-trip comparisons below
	// don't need null checks for values that are never actually null.
	personas: Array<
		Persona & { known_facts: string; personality_traits: string }
	>;
	referrals: ReferralEdge[];
	roots: string[];
};

// Builds an arbitrary but always-VALID case: every persona is reachable
// from a single root (persona 0) via a spanning tree (persona i's parent is
// a uniformly-chosen earlier persona, so induction on i guarantees a path
// back to 0), plus optional extra forward edges over the remaining i<j
// pairs for multi-parent (diamond) coverage. Edges only ever go from a
// lower to a higher index, so the graph is acyclic by construction — cycles
// and dangling/self-referrals are exercised separately in
// importCase.dom.test.ts, not here.
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
		// Candidate extra edges: every i<j pair not already the spanning edge
		// for j, each independently included or not.
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
				fc.array(textArb, { minLength: n, maxLength: n }), // per-edge condition text, reused by index
				textArb, // caseName
				textArb, // accessCode
				textArb, // initialBrief
				textArb, // commonInformation
				fc.option(fc.integer({ min: 0, max: 600 }), { nil: null }), // duration
				// Whether each non-first persona is *also* an explicit root
				// (persona 0 always is, to anchor the spanning tree). Kept in
				// ascending index order so it lines up with readCaseGraphFromDom's
				// own document-order traversal — see the roots comparison below.
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
						Persona & { known_facts: string; personality_traits: string }
					> = personaFields.map((fields, i) => ({
						id: ids[i] as string,
						name: fields.name,
						role: fields.role,
						profile_photo: null, // never carried by the exporter (see normalization below)
						known_facts: fields.known_facts,
						personality_traits: fields.personality_traits,
						availability_minutes: fields.availability_minutes,
						files: fields.files,
					}));

					const seen = new Set<string>();
					const referrals: ReferralEdge[] = [];
					const addEdge = (from: number, to: number, conditionIdx: number) => {
						const key = `${from}-${to}`;
						if (seen.has(key)) return;
						seen.add(key);
						referrals.push({
							from_id: ids[from] as string,
							to_id: ids[to] as string,
							conditions: conditionTexts[conditionIdx] as string,
						});
					};
					// Spanning tree: guarantees every persona is reachable from ids[0].
					parents.forEach((parent, idx) => {
						addEdge(parent, idx + 1, idx);
					});
					// Extra edges for multi-parent (diamond) coverage.
					extraCandidates.forEach(([i, j], k) => {
						if (extraFlags[k]) addEdge(i, j, k % n);
					});

					// ids[0] is always a root (it anchors the spanning tree); any
					// other persona may *also* be marked a root. Extra roots are
					// harmless to reachability (they're already reachable via the
					// spanning tree) — this just broadens coverage to multi-root
					// cases, not only the single-root minimum.
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

// Canonical, order-independent key for a referral edge (trimmed, since
// import trims every text field).
const edgeKey = (e: ReferralEdge) =>
	`${e.from_id}->${e.to_id}::${(e.conditions ?? "").trim()}`;

describe("buildHTMLForm / parseHTMLForm round trip", () => {
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

				// Imported personas get fresh ids (mintFreshPersonaIds in importCase.ts), so
				// `data`'s ids never equal `generated`'s -- what has to hold instead is that
				// the SAME remapping (by original persona, position-for-position via `zip`
				// below) makes every root and referral endpoint agree. `idMap` is exactly that
				// remapping, read off the personas array itself rather than re-derived, since
				// buildHTMLForm/parseHTMLForm preserve document order end to end.
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
					expect(imported.known_facts).toBe(original.known_facts.trim());
					expect(imported.personality_traits).toBe(
						original.personality_traits.trim(),
					);
					expect(imported.availability_minutes).toBe(
						original.availability_minutes,
					);
					// Expected lossiness: `file` itself never survives (see filesArb's
					// comment above) — everything else about each entry does, in
					// order. See importCase.dom.test.ts for the exact placeholder
					// shape.
					expect(imported.files).toEqual(
						original.files.map((file) => ({
							file: null,
							share_conditions: (file.share_conditions ?? "").trim(),
							perceived_contents: (file.perceived_contents ?? "").trim(),
						})),
					);
				}

				const importedEdgeKeys = data.referrals.map(edgeKey).sort();
				const originalEdgeKeys = generated.referrals
					.map((edge) =>
						edgeKey({
							from_id: idMap.get(edge.from_id) as string,
							to_id: idMap.get(edge.to_id) as string,
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

function* zip<A, B>(a: A[], b: B[]): Generator<[A, B]> {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) yield [a[i] as A, b[i] as B];
}
