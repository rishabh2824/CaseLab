// Temporary: strips the legacy shapes from stored cases. Delete this file (and its test) once it has run on every deployment.
import { internalMutation, internalQuery } from "./_generated/server";
import type { CaseStructure } from "./shared/validators";

type LegacyPersona = Record<string, unknown> & {
	files: Record<string, unknown>[];
};
type LegacyCase = {
	teachingNotes?: unknown;
	structure: {
		personas: LegacyPersona[];
		referrals: { fromId: string; toId: string; conditions: string }[];
		roots?: string[];
	};
};

// Whether a case still holds a stored roots list or a null where a value is now simply absent.
export function isLegacy({ teachingNotes, structure }: LegacyCase): boolean {
	return (
		teachingNotes === null ||
		structure.roots !== undefined ||
		structure.personas.some(
			(persona) =>
				persona.profilePhoto === null ||
				persona.availabilityMinutes === null ||
				persona.files.some((entry) => entry.file === null),
		)
	);
}

// Drops nulls and the stored roots, and drops referrals into a root: roots are always available, so those never did anything and would now make the root a referred persona.
export function reshapeStructure({ structure }: LegacyCase): CaseStructure {
	const roots = new Set(structure.roots ?? []);
	const personas = structure.personas.map(
		({ profilePhoto, availabilityMinutes, files, ...persona }) => ({
			...persona,
			...(profilePhoto ? { profilePhoto } : {}),
			...(typeof availabilityMinutes === "number"
				? { availabilityMinutes }
				: {}),
			files: files.filter((entry) => entry.file),
		}),
	);
	return {
		personas,
		referrals: structure.referrals.filter(({ toId }) => !roots.has(toId)),
	} as unknown as CaseStructure;
}

export const backfillCaseShape = internalMutation({
	args: {},
	handler: async (ctx) => {
		let updated = 0;
		for await (const c of ctx.db.query("cases")) {
			const legacy = c as unknown as LegacyCase;
			if (!isLegacy(legacy)) continue;
			await ctx.db.patch("cases", c._id, {
				structure: reshapeStructure(legacy),
				teachingNotes: c.teachingNotes ?? undefined,
			});
			updated += 1;
		}
		return { updated };
	},
});

export const checkCaseShape = internalQuery({
	args: {},
	handler: async (ctx) => {
		let legacy = 0;
		for await (const c of ctx.db.query("cases"))
			if (isLegacy(c as unknown as LegacyCase)) legacy += 1;
		return { legacy };
	},
});
