import { ConvexError } from "convex/values";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import type { AdminRole } from "../schema";
import { deleteCaseUnchecked } from "./cases";

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
// Better Auth's own `user` table (managed in its component's separate storage, not here) is
// identity only. Shared by auth.ts's databaseHooks.user.create.before (gates sign-in) and
// api/admins.ts's viewer query (gates the UI), so the lookup logic lives in exactly one
// place.
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
	// safeGetAuthUser, not getAuthUser -- the latter throws its own "Unauthenticated" for a
	// caller with no identity at all, which would shadow the message below.
	const user = await authComponent.safeGetAuthUser(ctx);
	if (!user?.email) throw new ConvexError("Not signed in.");
	const admin = await getAdminByEmail(ctx, user.email);
	if (!admin) throw new ConvexError("Your account is not authorized.");
	return admin;
}

// Listing admins only requires being signed in as *some* admin, but adding/deleting one is
// restricted to super admins.
export async function requireSuperAdmin(
	ctx: QueryCtx | MutationCtx,
): Promise<Doc<"admins">> {
	const admin = await requireCurrentAdmin(ctx);
	if (admin.role !== "super")
		throw new ConvexError("Only a super admin can do this.");
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
	if (!email) throw new ConvexError("An admin email is required.");
	if (await getAdminByEmail(ctx, email)) {
		throw new ConvexError("An admin with this email already exists.");
	}
	// Trimmed on the way in, same as every other free-text field this app stores (see e.g.
	// validateRequiredText, services/cases.ts) -- an admin invited as "  Jane Doe  " should be
	// stored and shown as "Jane Doe", not carry the pasted whitespace around forever.
	const name = args.name?.trim() || undefined;
	const id = await ctx.db.insert("admins", { email, name, role: args.role });
	const created = await ctx.db.get("admins", id);
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
				.withIndex("by_case", (q) => q.eq("caseId", c._id))
				.collect()
		).sort((a, b) => a.addedAt - b.addedAt);

		if (collaborators.length === 0) {
			// Same deletion services/cases.ts's own deleteCase performs, shared via
			// deleteCaseUnchecked -- see its comment for why this cascade skips the access
			// check that helper's caller (deleteCase) normally runs first.
			await deleteCaseUnchecked(ctx, c._id);
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
	await revokeAdminSessions(ctx, admin.email);

	return { ok: true, casesDeleted, casesReassigned };
}

// requireCurrentAdmin re-checks the `admins` table on every call, so a deleted admin is
// already locked out of everything -- but without this, their existing Better Auth session
// stays live for up to its own JWT expiry (15 minutes, see @convex-dev/better-auth's default
// jwtExpirationSeconds), since a customJwt is verified cryptographically and Convex never
// re-checks it against the session row it was minted from. Deleting the `session` rows here
// makes authComponent.safeGetAuthUser's own re-check of the *session* (not just the JWT)
// fail on the deleted admin's very next request, closing that window immediately instead of
// waiting it out. Leaves the Better Auth `user` row itself in place -- it's identity-only
// (see this file's own header comment), and a re-invited admin with the same Google account
// should resume as the same user rather than mint a fresh one.
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
		// An admin realistically holds a handful of sessions (one per signed-in browser) --
		// well under one page, so there's no second page to chase.
		paginationOpts: { numItems: 200, cursor: null },
	});
}
