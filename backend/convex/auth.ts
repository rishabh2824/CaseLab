import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";
import type { MutationCtx } from "./_generated/server";
import { getAdminByEmail } from "./services/admins";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
	providers: [Google],
	callbacks: {
		// Mirrors backend/services/admin.py::loginWithGoogleCredential: `admins` is the
		// authorization gate, not Convex Auth's own `users` table (identity only).
		// Throwing here rejects the whole sign-in — an authenticated Google account
		// with no matching row never gets a `users` row created for it.
		async createOrUpdateUser(ctx: MutationCtx, args) {
			if (args.existingUserId) return args.existingUserId;

			const email = args.profile.email as string | undefined;
			if (!email) throw new Error("Google account has no email.");

			const admin = await getAdminByEmail(ctx, email);
			if (!admin) throw new Error("Your account is not authorized.");

			return ctx.db.insert("users", {
				email,
				name: (args.profile.name as string | undefined) ?? admin.name,
			});
		},
	},
});
