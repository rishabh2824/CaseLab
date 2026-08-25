import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { components } from "./_generated/api";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();
// cors: true -- the SvelteKit app calls these routes cross-origin (Convex's own
// domain, not the app's), via the crossDomain plugin configured in auth.ts.
authComponent.registerRoutes(http, createAuth, { cors: true });

// No more /files/:objectKey route: file storage is Convex's own now, and
// ctx.storage.getUrl is plain query-safe data access (see services/simulations.ts's
// fileUrl), so there's no presign-and-redirect step left that needs an HTTP action.

// Exact routes above win over this catch-all -- keeps auth's routes at their
// current URLs while the static frontend build owns everything else at root. Every
// route is client-only (routes/+layout.ts sets ssr=false app-wide, nothing
// overrides it -- see vite.config.ts's adapter comment), so the single index.html
// this build emits is both the real "/" response and, via this SPA fallback,
// correct for a hard nav/reload to any other route too.
registerStaticRoutes(http, components.staticHosting);

export default http;
