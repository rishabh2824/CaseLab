import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent, deleteAuthUser } from "../auth";
import { appError, ERROR_CODE } from "../shared/errors";
import type { AdminRole } from "../shared/validators";
import { getAdminByEmail, normalizeEmail } from "./adminLookup";
import { deleteCaseUnchecked } from "./cases";

// Returns the signed-in admin's basic profile, or null for anonymous and non-admin callers.
export async function viewerProfile(ctx: QueryCtx) {
	const user = await authComponent.safeGetAuthUser(ctx);
	if (!user?.email) return null;

	const admin = await getAdminByEmail(ctx, user.email);
	if (!admin) return null;

	return {
		_id: admin._id,
		email: admin.email,
		name: admin.name,
		role: admin.role,
	};
}

// Returns the signed-in admin, throwing if the caller is anonymous or not on the roster.
export async function requireCurrentAdmin(
	ctx: QueryCtx | MutationCtx,
): Promise<Doc<"admins">> {
	const user = await authComponent.safeGetAuthUser(ctx);
	if (!user?.email) throw appError(ERROR_CODE.NOT_SIGNED_IN, "Not signed in.");
	const admin = await getAdminByEmail(ctx, user.email);
	if (!admin)
		throw appError(
			ERROR_CODE.NOT_AUTHORIZED,
			"Your account is not authorized.",
		);
	return admin;
}

// Returns the signed-in admin, throwing unless they are a super admin.
export async function requireSuperAdmin(
	ctx: QueryCtx | MutationCtx,
): Promise<Doc<"admins">> {
	const admin = await requireCurrentAdmin(ctx);
	if (admin.role !== "super")
		throw appError(
			ERROR_CODE.SUPER_ADMIN_ONLY,
			"Only a super admin can do this.",
		);
	return admin;
}

// Returns every admin sorted by email.
export async function listAdmins(ctx: QueryCtx): Promise<Doc<"admins">[]> {
	const admins = await ctx.db.query("admins").collect();
	return admins.sort((a, b) => a.email.localeCompare(b.email));
}

// Creates an admin from a normalized email, rejecting blank names and blank or duplicate emails.
export async function createAdmin(
	ctx: MutationCtx,
	args: { email: string; name: string; role: AdminRole },
): Promise<Doc<"admins">> {
	const email = normalizeEmail(args.email);
	if (!email)
		throw appError(ERROR_CODE.INVALID_ADMIN, "An admin email is required.");
	const name = args.name.trim();
	if (!name)
		throw appError(ERROR_CODE.INVALID_ADMIN, "An admin name is required.");
	if (await getAdminByEmail(ctx, email)) {
		throw appError(
			ERROR_CODE.INVALID_ADMIN,
			"An admin with this email already exists.",
		);
	}
	const id = await ctx.db.insert("admins", { email, name, role: args.role });
	return (await ctx.db.get("admins", id))!;
}

// Deletes an admin along with the cases they own and their sign-in (sessions, accounts and user).
export async function deleteAdminWithCascade(
	ctx: MutationCtx,
	adminId: Id<"admins">,
): Promise<{ casesDeleted: number }> {
	const admin = await ctx.db.get("admins", adminId);
	if (!admin) throw appError(ERROR_CODE.ADMIN_NOT_FOUND, "Admin not found.");
	if (admin.role === "super")
		throw appError(ERROR_CODE.INVALID_ADMIN, "Super admins cannot be deleted.");

	const ownedCases = await ctx.db
		.query("cases")
		.withIndex("by_owner", (q) => q.eq("ownerAdminId", adminId))
		.collect();
	for (const c of ownedCases) await deleteCaseUnchecked(ctx, c._id);

	const collaboratingElsewhere = await ctx.db
		.query("collaborators")
		.withIndex("by_admin", (q) => q.eq("adminId", adminId))
		.collect();
	for (const row of collaboratingElsewhere)
		await ctx.db.delete("collaborators", row._id);

	await ctx.db.delete("admins", adminId);
	await deleteAuthUser(ctx, admin.email);

	return { casesDeleted: ownedCases.length };
}
