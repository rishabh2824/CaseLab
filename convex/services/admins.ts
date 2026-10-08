import { ConvexError } from "convex/values";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import type { AdminRole } from "../lib/constants";
import { deleteCaseUnchecked } from "./cases";

// Trims and lower-cases an email so lookups ignore casing and padding.
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

// Finds an admin by email, ignoring casing and padding.
export async function getAdminByEmail(
	ctx: QueryCtx | MutationCtx,
	email: string,
) {
	return ctx.db
		.query("admins")
		.withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
		.unique();
}

// Returns the signed-in admin, throwing if the caller is anonymous or not on the roster.
export async function requireCurrentAdmin(
	ctx: QueryCtx | MutationCtx,
): Promise<Doc<"admins">> {
	const user = await authComponent.safeGetAuthUser(ctx);
	if (!user?.email) throw new ConvexError("Not signed in.");
	const admin = await getAdminByEmail(ctx, user.email);
	if (!admin) throw new ConvexError("Your account is not authorized.");
	return admin;
}

// Returns the signed-in admin, throwing unless they are a super admin.
export async function requireSuperAdmin(
	ctx: QueryCtx | MutationCtx,
): Promise<Doc<"admins">> {
	const admin = await requireCurrentAdmin(ctx);
	if (admin.role !== "super")
		throw new ConvexError("Only a super admin can do this.");
	return admin;
}

// Returns every admin sorted by email.
export async function listAdmins(ctx: QueryCtx): Promise<Doc<"admins">[]> {
	const admins = await ctx.db.query("admins").collect();
	return admins.sort((a, b) => a.email.localeCompare(b.email));
}

// Creates an admin from a normalized email, rejecting blank and duplicate emails.
export async function createAdmin(
	ctx: MutationCtx,
	args: { email: string; name?: string; role: AdminRole },
): Promise<Doc<"admins">> {
	const email = normalizeEmail(args.email);
	if (!email) throw new ConvexError("An admin email is required.");
	if (await getAdminByEmail(ctx, email)) {
		throw new ConvexError("An admin with this email already exists.");
	}
	const name = args.name?.trim() || undefined;
	const id = await ctx.db.insert("admins", { email, name, role: args.role });
	const created = await ctx.db.get("admins", id);
	if (!created) throw new Error("Failed to create admin.");
	return created;
}

// Deletes an admin, deleting or handing over the cases they own and revoking their sessions.
export async function deleteAdminWithCascade(
	ctx: MutationCtx,
	adminId: Id<"admins">,
): Promise<{ ok: true; casesDeleted: number; casesReassigned: number }> {
	const admin = await ctx.db.get("admins", adminId);
	if (!admin) throw new ConvexError("Admin not found.");
	if (admin.role === "super")
		throw new ConvexError("Super admins cannot be deleted.");

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
				.withIndex("by_case_and_admin", (q) => q.eq("caseId", c._id))
				.collect()
		).sort((a, b) => a._creationTime - b._creationTime);

		if (collaborators.length === 0) {
			await deleteCaseUnchecked(ctx, c._id);
			casesDeleted++;
		} else {
			const oldest = collaborators[0]!;
			await ctx.db.patch(c._id, { ownerAdminId: oldest.adminId });
			await ctx.db.delete(oldest._id);
			casesReassigned++;
		}
	}

	const collaboratingElsewhere = await ctx.db
		.query("collaborators")
		.withIndex("by_admin", (q) => q.eq("adminId", adminId))
		.collect();
	for (const row of collaboratingElsewhere) await ctx.db.delete(row._id);

	await ctx.db.delete(adminId);
	await revokeAdminSessions(ctx, admin.email);

	return { ok: true, casesDeleted, casesReassigned };
}

// Deletes the Better Auth sessions of the user with the given email.
async function revokeAdminSessions(
	ctx: MutationCtx,
	email: string,
): Promise<void> {
	const users = await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: "user",
		where: [{ field: "email", value: normalizeEmail(email) }],
		paginationOpts: { numItems: 1, cursor: null },
	});
	const user = users.page[0];
	if (!user) return;
	await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
		input: {
			model: "session",
			where: [{ field: "userId", value: user._id }],
		},
		paginationOpts: { numItems: 200, cursor: null },
	});
}
