import betterAuth from "@convex-dev/better-auth/convex.config";
import persistentTextStreaming from "@convex-dev/persistent-text-streaming/convex.config.js";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
	env: {
		DEMO_CASE_ID: v.optional(v.string()),
	},
});
app.use(betterAuth);
app.use(persistentTextStreaming);
app.use(staticHosting);

export default app;
