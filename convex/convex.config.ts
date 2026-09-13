import betterAuth from "@convex-dev/better-auth/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
	env: {
		// The shared example case api/cases:getDemo serves to every signed-in admin --
		// per-deployment (dev and prod each seed their own case, so they get different real
		// ids; Convex mints ids on insert, they don't survive a re-import) via `npx convex env
		// set DEMO_CASE_ID <id>` rather than a hardcoded id in source, which broke the moment
		// dev's own case didn't share prod's id. Optional: getDemo returns null (not a demo
		// case, not an error) when a deployment hasn't set one.
		DEMO_CASE_ID: v.optional(v.string()),
	},
});
app.use(betterAuth);
app.use(rateLimiter);
// No httpPrefix: http.ts keeps auth's routes at the root and registers the
// static catch-all itself (registerStaticRoutes), so exact routes win.
app.use(staticHosting);

export default app;
