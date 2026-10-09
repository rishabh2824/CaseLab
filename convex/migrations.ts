import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { CaseStructure, FileRefPayload } from "./models/cases";
import type { LegacyCaseStructure } from "./models/legacyCases";

type LegacyFileRef = LegacyCaseStructure["personas"][number]["profile_photo"];

// Converts a snake_case file reference to the camelCase shape.
function camelRef(ref: LegacyFileRef): FileRefPayload {
	return ref
		? {
				storageId: ref.storage_id,
				fileName: ref.file_name,
				contentType: ref.content_type,
			}
		: null;
}

// Returns the camelCase form of a case structure stored in either shape, and whether it had to change.
export function toCamelStructure(
	structure: CaseStructure | LegacyCaseStructure,
): {
	structure: CaseStructure;
	changed: boolean;
} {
	const first = structure.personas[0];
	if (!first || !("profile_photo" in first))
		return { structure: structure as CaseStructure, changed: false };
	const legacy = structure as LegacyCaseStructure;
	return {
		changed: true,
		structure: {
			personas: legacy.personas.map((p) => ({
				id: p.id,
				name: p.name,
				role: p.role,
				profilePhoto: camelRef(p.profile_photo),
				knownFacts: p.known_facts,
				personalityTraits: p.personality_traits,
				availabilityMinutes: p.availability_minutes ?? null,
				files: p.files.map((entry) => ({
					file: camelRef(entry.file),
					shareConditions: entry.share_conditions,
					perceivedContents: entry.perceived_contents,
				})),
			})),
			referrals: legacy.referrals.map((r) => ({
				fromId: r.from_id,
				toId: r.to_id,
				conditions: r.conditions,
			})),
			roots: legacy.roots,
		},
	};
}

// TEMPORARY one-time backfill: flags every existing case as not a demo. Delete once it has run on every deployment.
export const backfillCases = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cases = await ctx.db.query("cases").collect();
		for (const c of cases) {
			if (c.isDemo === undefined)
				await ctx.db.patch("cases", c._id, { isDemo: false });
		}
		return cases.length;
	},
});

// TEMPORARY one-time backfill for the camelCase rename: rewrites every case structure from snake_case
// keys to camelCase (skipping cases already converted) and moves runMessages.personaKey to personaId.
// Run it while no student is in a run, between widening and narrowing the schema.
export const backfillCamelCase = internalMutation({
	args: {},
	handler: async (ctx) => {
		let converted = 0;
		for (const c of await ctx.db.query("cases").collect()) {
			const { structure, changed } = toCamelStructure(c.structure);
			if (!changed) continue;
			await ctx.db.patch("cases", c._id, { structure });
			converted++;
		}
		for (const row of await ctx.db.query("runMessages").collect()) {
			const personaKey = (row as unknown as { personaKey?: string }).personaKey;
			if (personaKey === undefined) continue;
			await ctx.db.patch("runMessages", row._id, {
				personaId: personaKey,
				personaKey: undefined,
			} as Partial<Doc<"runMessages">>);
		}
		return converted;
	},
});

// TEMPORARY one-time backfill for deployments that already hold runMessages rows: marks every
// existing row as done. Run it while runMessages.status is still optional, before making it required.
export const backfillMessages = internalMutation({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query("runMessages").collect();
		let patched = 0;
		for (const row of rows) {
			if (row.status !== undefined) continue;
			await ctx.db.patch("runMessages", row._id, { status: "done" });
			patched++;
		}
		return patched;
	},
});

// TEMPORARY one-time backfill for the removal of the files table: rebuilds every case's caseFiles
// links from the storage ids in its structure and clears runs' shared file lists (they held old
// file ids). Run it while no student is in a run, between widening and narrowing the schema.
export const backfillCaseFiles = internalMutation({
	args: {},
	handler: async (ctx) => {
		for (const row of await ctx.db.query("caseFiles").collect())
			await ctx.db.delete("caseFiles", row._id);

		const cases = await ctx.db.query("cases").collect();
		for (const c of cases) {
			const storageIds = new Set(
				toCamelStructure(c.structure)
					.structure.personas.flatMap((persona) => [
						persona.profilePhoto,
						...persona.files.map((entry) => entry.file),
					])
					.flatMap((ref) => (ref ? [ref.storageId] : [])),
			);
			for (const storageId of storageIds)
				await ctx.db.insert("caseFiles", { caseId: c._id, storageId });
		}

		for (const run of await ctx.db.query("runs").collect()) {
			if (run.sharedFiles.length > 0)
				await ctx.db.patch("runs", run._id, { sharedFiles: [] });
		}
		return cases.length;
	},
});
