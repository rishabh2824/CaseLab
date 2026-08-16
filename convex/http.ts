import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { components } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);

// No more /files/:objectKey route: file storage is Convex's own now, and
// ctx.storage.getUrl is plain query-safe data access (see services/simulations.ts's
// fileUrl), so there's no presign-and-redirect step left that needs an HTTP action.

// Exact routes above win over this catch-all -- keeps auth's routes at their
// current URLs while the static frontend build owns everything else at root.
registerStaticRoutes(http, components.staticHosting);

export default http;
