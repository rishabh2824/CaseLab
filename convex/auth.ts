import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import authConfig from "./auth.config";
import { getAdminByEmail } from "./services/admins";

export const authComponent = createClient<DataModel>(components.betterAuth);

// databaseHooks.user.create.before (below) only gets a GenericCtx -- an action-shaped
// context with runQuery/runMutation, not the direct ctx.db a plain QueryCtx/MutationCtx
// has -- so the admins-table lookup has to go through a real query instead of calling
// getAdminByEmail(ctx, ...) inline.
export const adminForSignIn = internalQuery({
	args: { email: v.string() },
	handler: async (ctx, { email }) => getAdminByEmail(ctx, email),
});

// baseURL is Convex's own site URL, not this app's domain -- the client talks to
// Convex directly (see the crossDomain plugin below) instead of through a SvelteKit
// server proxy, since this project has no server runtime to run one (adapter-static,
// ssr=false everywhere).
export const createAuth = (ctx: GenericCtx<DataModel>) =>
	betterAuth({
		baseURL: process.env.CONVEX_SITE_URL,
		database: authComponent.adapter(ctx),
		socialProviders: {
			google: {
				clientId: process.env.GOOGLE_CLIENT_ID as string,
				clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
			},
		},
		databaseHooks: {
			user: {
				create: {
					// `admins` is the authorization gate, not Better Auth's own `user` table
					// (identity only) -- throwing here rejects the whole sign-in, same as
					// classic Convex Auth's createOrUpdateUser callback did. Only fires on a
					// brand-new Google account; a returning admin later removed from `admins`
					// is still turned away, just at the next admin-gated query/mutation
					// (services/admins.ts's requireCurrentAdmin) rather than here.
					before: async (user) => {
						const email = user.email as string | undefined;
						if (!email) {
							throw new APIError("BAD_REQUEST", {
								message: "Google account has no email.",
							});
						}

						const admin = await ctx.runQuery(internal.auth.adminForSignIn, {
							email,
						});
						if (!admin) {
							throw new APIError("UNAUTHORIZED", {
								message: "Your account is not authorized.",
							});
						}

						return { data: { ...user, name: user.name ?? admin.name } };
					},
				},
			},
		},
		// crossDomain + { cors: true } on registerRoutes (see http.ts) lets the SvelteKit
		// app talk to Convex's own domain directly for auth, bridged by a one-time-token
		// redirect -- see convex/auth.ts's sibling comment above for why there's no proxy.
		plugins: [
			crossDomain({ siteUrl: process.env.SITE_URL as string }),
			convex({ authConfig }),
		],
	});
