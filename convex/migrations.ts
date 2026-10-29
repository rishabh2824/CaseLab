import { internalMutation } from "./_generated/server";

// One-off: gives every existing collaborator row the full "edit" access they had before access levels existed. Safe to re-run; delete this file once prod has run it.
export const backfillCollaboratorAccess = internalMutation({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query("collaborators").take(1000);
		let patched = 0;
		for (const row of rows) {
			if ((row as { access?: string }).access !== undefined) continue;
			await ctx.db.patch("collaborators", row._id, { access: "edit" });
			patched++;
		}
		return patched;
	},
});
