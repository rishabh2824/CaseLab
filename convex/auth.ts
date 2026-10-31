import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { env, internalQuery } from "./_generated/server";
import authConfig from "./auth.config";
import { getAdminByEmail } from "./model/admins";

export const authComponent = createClient<DataModel>(components.betterAuth);

// Looks up the admin for an email during sign-in.
export const adminForSignIn = internalQuery({
	args: { email: v.string() },
	handler: async (ctx, { email }) => getAdminByEmail(ctx, email),
});

// Builds the Better Auth instance, allowing only Google accounts that are on the admin roster.
export const createAuth = (ctx: GenericCtx<DataModel>) =>
	betterAuth({
		baseURL: env.CONVEX_SITE_URL,
		database: authComponent.adapter(ctx),
		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
			},
		},
		databaseHooks: {
			user: {
				create: {
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
		plugins: [crossDomain({ siteUrl: env.SITE_URL }), convex({ authConfig })],
	});
