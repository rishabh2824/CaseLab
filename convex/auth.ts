import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { env, internalQuery, type MutationCtx } from "./_generated/server";
import authConfig from "./auth.config";
import { getAdminByEmail, normalizeEmail } from "./model/adminLookup";

export const authComponent = createClient<DataModel>(components.betterAuth);

// Looks up the admin for an email during sign-in.
export const adminForSignIn = internalQuery({
	args: { email: v.string() },
	handler: async (ctx, { email }) => getAdminByEmail(ctx, email),
});

// Deletes every Better Auth session, account and the user itself for the given email, so no trace of the admin's sign-in remains.
export async function deleteAuthUser(
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

	for (const model of ["session", "account"] as const) {
		let cursor: string | null = null;
		for (;;) {
			const result: { isDone: boolean; continueCursor: string } =
				await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
					input: { model, where: [{ field: "userId", value: user._id }] },
					paginationOpts: { numItems: 200, cursor },
				});
			if (result.isDone) break;
			cursor = result.continueCursor;
		}
	}
	await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
		input: { model: "user", where: [{ field: "_id", value: user._id }] },
	});
}

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
