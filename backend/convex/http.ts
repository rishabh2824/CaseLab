import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { presignGetUrl } from "./lib/spaces";

const http = httpRouter();
auth.addHttpRoutes(http);

// Mirrors backend/infra/settings.py's spaces_download_expiry: long enough to outlast a run
// (120min cap + 30min margin), since a persona photo or shared-file link handed out early in
// a simulation must still resolve near the end of it.
const DOWNLOAD_EXPIRY_SECONDS = (120 + 30) * 60;

// Mirrors backend/services/simulation/state.py's hydratePersona/toSharedFileOut, split
// across the query/httpAction boundary Convex requires: presigning is timestamp-dependent
// (a fresh signature every call), which doesn't belong inside a query Convex may cache or
// re-run. Queries (services/simulations.ts) hand out this stable path instead of a signed
// URL directly -- it never changes, so it caches in the browser the way a signed URL with a
// constantly-rotating query string never could -- and this route signs fresh + redirects
// only at the moment a request for it actually arrives.
http.route({
	pathPrefix: "/files/",
	method: "GET",
	handler: httpAction(async (_ctx, req) => {
		const objectKey = decodeURIComponent(new URL(req.url).pathname.slice("/files/".length));
		if (!objectKey) return new Response("Not found", { status: 404 });
		const signedUrl = await presignGetUrl(objectKey, DOWNLOAD_EXPIRY_SECONDS);
		return Response.redirect(signedUrl, 302);
	}),
});

export default http;
