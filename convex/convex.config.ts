import betterAuth from "@convex-dev/better-auth/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

// Deploys fail when a required variable is missing, instead of the first sign-in or chat reply failing.
const app = defineApp({
	env: {
		GOOGLE_CLIENT_ID: v.string(),
		GOOGLE_CLIENT_SECRET: v.string(),
		SITE_URL: v.string(),
		LLM_KEY: v.string(),
		// Overridable so an end-to-end run can point the backend at a local stand-in for the provider.
		LLM_BASE_URL: v.optional(v.string()),
	},
});
app.use(betterAuth);
app.use(staticHosting);

export default app;
