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
