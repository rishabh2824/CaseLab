import { internalMutation } from "./_generated/server";

// TEMPORARY one-time backfill: flags every existing case as not a demo and gives personas
// without an availability an explicit null. Delete once it has run on every deployment.
export const backfillCases = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cases = await ctx.db.query("cases").collect();
		for (const c of cases) {
			await ctx.db.patch("cases", c._id, {
				isDemo: c.isDemo ?? false,
				structure: {
					...c.structure,
					personas: c.structure.personas.map((persona) => ({
						...persona,
						availability_minutes: persona.availability_minutes ?? null,
					})),
				},
			});
		}
		return cases.length;
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
				c.structure.personas
					.flatMap((persona) => [
						persona.profile_photo,
						...persona.files.map((entry) => entry.file),
					])
					.flatMap((ref) => (ref ? [ref.storage_id] : [])),
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
