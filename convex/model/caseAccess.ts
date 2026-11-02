import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError, ERROR_CODE } from "../shared/errors";
import type { CollaboratorAccess } from "../shared/validators";

// The one access rule: super admins and the owner can edit, a collaborator gets the level they were given, anyone else gets nothing.
export function resolveAccess(
	admin: Doc<"admins">,
	c: Doc<"cases">,
	collaboratorAccess: CollaboratorAccess | undefined,
): CollaboratorAccess | null {
	if (admin.role === "super" || c.ownerAdminId === admin._id) return "edit";
	return collaboratorAccess ?? null;
}

// Returns the access an admin has to a case, looking up their collaborator row.
export async function caseAccess(
	ctx: QueryCtx | MutationCtx,
	c: Doc<"cases">,
	admin: Doc<"admins">,
): Promise<CollaboratorAccess | null> {
	// Super admins and owners need no collaborator row.
	if (resolveAccess(admin, c, undefined) === "edit") return "edit";
	const collaborating = await ctx.db
		.query("collaborators")
		.withIndex("by_case_and_admin", (q) =>
			q.eq("caseId", c._id).eq("adminId", admin._id),
		)
		.first();
	return resolveAccess(admin, c, collaborating?.access);
}

// Returns the admin's access to a case, throwing if they have none or less than needed.
export async function requireCaseAccess(
	ctx: QueryCtx | MutationCtx,
	c: Doc<"cases">,
	admin: Doc<"admins">,
	need: CollaboratorAccess = "edit",
): Promise<CollaboratorAccess> {
	const access = await caseAccess(ctx, c, admin);
	if (access === null)
		throw appError(
			ERROR_CODE.NO_CASE_ACCESS,
			"You do not have access to this case.",
		);
	if (need === "edit" && access !== "edit")
		throw appError(
			ERROR_CODE.VIEW_ONLY,
			"You have view-only access to this case.",
		);
	return access;
}

// Loads a case and checks the admin may access it, throwing if it is missing or off limits.
export async function loadCaseForAccess(
	ctx: QueryCtx | MutationCtx,
	caseId: Id<"cases">,
	admin: Doc<"admins">,
	need: CollaboratorAccess = "edit",
): Promise<Doc<"cases">> {
	const c = await ctx.db.get("cases", caseId);
	if (!c) throw appError(ERROR_CODE.CASE_NOT_FOUND, "Case not found.");
	await requireCaseAccess(ctx, c, admin, need);
	return c;
}
