import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { AdminRole } from "../schema";
import { syncCaseFiles } from "./files";

// Email addresses are matched case-insensitively, so `admins.email` is stored and looked up
// in exactly one canonical form. Convex has no case-insensitive index, so normalization has
// to happen at every read and write instead. Without it, a super admin who invites
// "Jane.Doe@wisc.edu" creates a roster row that Google's lower-cased profile email can never
// match -- the invited admin is turned away at sign-in with "Your account is not authorized."
// and nothing in the UI explains why -- and the same gap lets two rows exist for one person,
// which `unique()` below would then throw on.
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

// The `admins` table is the authorization gate everywhere an admin identity is needed --
// Convex Auth's own `users` table (from authTables in schema.ts) is identity only. Shared by
// auth.ts's createOrUpdateUser callback (gates sign-in) and api/admins.ts's viewer query
// (gates the UI), so the lookup logic lives in exactly one place.
export async function getAdminByEmail(
	ctx: QueryCtx | MutationCtx,
	email: string,
) {
	return ctx.db
		.query("admins")
		.withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
		.unique();
}

// The signed-in admin, or throws. Convex has no middleware layer -- lib/adminFunctions.ts's
// adminQuery/adminMutation call this so individual handlers don't have to.
export async function requireCurrentAdmin(
	ctx: QueryCtx | MutationCtx,
): Promise<Doc<"admins">> {
	const userId = await getAuthUserId(ctx);
	if (!userId) throw new Error("Not signed in.");
	const user = await ctx.db.get(userId);
	if (!user?.email) throw new Error("Not signed in.");
	const admin = await getAdminByEmail(ctx, user.email);
	if (!admin) throw new Error("Your account is not authorized.");
	return admin;
}

// Listing admins only requires being signed in as *some* admin, but adding/deleting one is
// restricted to super admins.
export async function requireSuperAdmin(
	ctx: QueryCtx | MutationCtx,
): Promise<Doc<"admins">> {
	const admin = await requireCurrentAdmin(ctx);
	if (admin.role !== "super")
		throw new Error("Only a super admin can do this.");
	return admin;
}

// At ~20 admins total, sorting the full list in memory is simpler than an indexed sort and
// just as fast.
export async function listAdmins(ctx: QueryCtx): Promise<Doc<"admins">[]> {
	const admins = await ctx.db.query("admins").collect();
	return admins.sort((a, b) => a.email.localeCompare(b.email));
}

export async function createAdmin(
	ctx: MutationCtx,
	args: { email: string; name?: string; role: AdminRole },
): Promise<Doc<"admins">> {
	const email = normalizeEmail(args.email);
	// A blank email would create a roster row nobody can ever sign in as (requireCurrentAdmin
	// refuses an identity with no email), while still occupying the roster and the by_email
	// index.
	if (!email) throw new Error("An admin email is required.");
	if (await getAdminByEmail(ctx, email)) {
		throw new Error("An admin with this email already exists.");
	}
	const id = await ctx.db.insert("admins", { ...args, email });
	const created = await ctx.db.get(id);
	if (!created) throw new Error("Failed to create admin.");
	return created;
}

// For every case this admin owns, delete it if nobody else has access, or promote the
// longest-standing collaborator to owner if someone does -- a case only ever gets deleted
// once no admin has access to it anymore. Convex mutations are single transactions, so this
// needs no explicit commit/rollback: a thrown error undoes every write made so far.
export async function deleteAdminWithCascade(
	ctx: MutationCtx,
	adminId: Id<"admins">,
): Promise<{ ok: true; casesDeleted: number; casesReassigned: number }> {
	const admin = await ctx.db.get(adminId);
	if (!admin) throw new Error("Admin not found.");
	if (admin.role === "super")
		throw new Error("Super admins cannot be deleted.");

	const ownedCases = await ctx.db
		.query("cases")
		.withIndex("by_owner", (q) => q.eq("ownerAdminId", adminId))
		.collect();

	let casesDeleted = 0;
	let casesReassigned = 0;

	for (const c of ownedCases) {
		const collaborators = (
			await ctx.db
				.query("collaborators")
				.withIndex("by_case", (q) => q.eq("caseId", c._id))
				.collect()
		).sort((a, b) => a.addedAt - b.addedAt);

		if (collaborators.length === 0) {
			// Empty desired set: removes every caseFiles row for this case and schedules
			// storage/`files` cleanup for anything that was only referenced here.
			await syncCaseFiles(ctx, c._id, new Set());
			await ctx.db.delete(c._id);
			casesDeleted++;
		} else {
			const oldest = collaborators[0]!;
			await ctx.db.patch(c._id, { ownerAdminId: oldest.adminId });
			// They're the case's owner now, not a collaborator on it.
			await ctx.db.delete(oldest._id);
			casesReassigned++;
		}
	}

	// Cascade-clean any rows where this admin is a *collaborator* elsewhere — disjoint
	// from the loop above by construction, since an admin never collaborates on their own
	// case.
	const collaboratingElsewhere = await ctx.db
		.query("collaborators")
		.withIndex("by_admin", (q) => q.eq("adminId", adminId))
		.collect();
	for (const row of collaboratingElsewhere) await ctx.db.delete(row._id);

	await ctx.db.delete(adminId);

	return { ok: true, casesDeleted, casesReassigned };
}
