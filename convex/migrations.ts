import { internalMutation } from "./_generated/server";

// One-off: renames the old `isDemo` flag on every case to `isTemplate`. Safe to re-run; delete this file once prod has run it.
export const backfillTemplate = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cases = await ctx.db.query("cases").take(1000);
		let patched = 0;
		for (const c of cases) {
			const legacy = c as typeof c & { isDemo?: boolean };
			if (legacy.isDemo === undefined && typeof c.isTemplate === "boolean")
				continue;
			await ctx.db.patch("cases", c._id, {
				isTemplate: c.isTemplate ?? legacy.isDemo ?? false,
				isDemo: undefined,
			} as Partial<typeof c>);
			patched++;
		}
		return patched;
	},
});
