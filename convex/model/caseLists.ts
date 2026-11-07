import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { CollaboratorAccess } from "../shared/validators";
import { resolveAccess } from "./caseAccess";

export type CaseSummary = {
	_id: Id<"cases">;
	name: string;
	accessCode: string;
	isTemplate: boolean;
	canEdit: boolean;
};

// Reduces a case document to its id, name, access code, template flag and whether the viewer may edit it.
function toCaseSummary(
	c: Doc<"cases">,
	admin: Doc<"admins">,
	collaboratorAccess?: CollaboratorAccess,
): CaseSummary {
	return {
		_id: c._id,
		name: c.name,
		accessCode: c.accessCode,
		isTemplate: c.isTemplate,
		canEdit: resolveAccess(admin, c, collaboratorAccess) === "edit",
	};
}

// Lists the cases an admin can see by name: all for a super admin, otherwise owned plus collaborating.
export async function listCases(
	ctx: QueryCtx,
	admin: Doc<"admins">,
): Promise<CaseSummary[]> {
	if (admin.role === "super") {
		const all = await ctx.db.query("cases").collect();
		return all
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((c) => toCaseSummary(c, admin));
	}

	const owned = await ctx.db
		.query("cases")
		.withIndex("by_owner", (q) => q.eq("ownerAdminId", admin._id))
		.collect();

	const collaboratingRows = await ctx.db
		.query("collaborators")
		.withIndex("by_admin", (q) => q.eq("adminId", admin._id))
		.collect();
	const collaboratingCases = await Promise.all(
		collaboratingRows.map((row) => ctx.db.get("cases", row.caseId)),
	);

	const byId = new Map<Id<"cases">, CaseSummary>();
	for (const c of owned) byId.set(c._id, toCaseSummary(c, admin));
	collaboratingRows.forEach((row, i) => {
		const c = collaboratingCases[i];
		if (c) byId.set(c._id, toCaseSummary(c, admin, row.access));
	});

	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Lists the cases an admin can copy as a template by name: the ones they can see plus every flagged template, without access codes.
export async function listTemplateChoices(
	ctx: QueryCtx,
	admin: Doc<"admins">,
): Promise<Pick<CaseSummary, "_id" | "name">[]> {
	const visible = await listCases(ctx, admin);
	const templates = await ctx.db
		.query("cases")
		.withIndex("by_is_template", (q) => q.eq("isTemplate", true))
		.collect();
	const byId = new Map<Id<"cases">, string>();
	for (const c of [...visible, ...templates]) byId.set(c._id, c.name);
	return Array.from(byId, ([_id, name]) => ({ _id, name })).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

// Returns the name and email of each of a case's authors: the owner first, then collaborators with edit access.
export async function listCaseAuthors(
	ctx: QueryCtx,
	c: Doc<"cases">,
): Promise<{ name: string; email: string }[]> {
	const rows = await ctx.db
		.query("collaborators")
		.withIndex("by_case_and_admin", (q) => q.eq("caseId", c._id))
		.collect();
	const adminIds = [
		c.ownerAdminId,
		...rows.filter((row) => row.access === "edit").map((row) => row.adminId),
	];
	const admins = await Promise.all(
		adminIds.map((id) => ctx.db.get("admins", id)),
	);
	return admins.flatMap((admin) =>
		admin ? [{ name: admin.name, email: admin.email }] : [],
	);
}
