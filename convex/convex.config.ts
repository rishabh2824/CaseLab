import betterAuth from "@convex-dev/better-auth/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(betterAuth);
app.use(rateLimiter);
// No httpPrefix: http.ts keeps auth's routes at the root and registers the
// static catch-all itself (registerStaticRoutes), so exact routes win.
app.use(staticHosting);

export default app;
