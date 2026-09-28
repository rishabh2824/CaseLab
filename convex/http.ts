import type { StreamId } from "@convex-dev/persistent-text-streaming";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { streaming } from "./lib/streaming";
import { runTurn } from "./services/turn";

const http = httpRouter();
// cors: true -- the SvelteKit app calls these routes cross-origin (Convex's own
// domain, not the app's), via the crossDomain plugin configured in auth.ts.
authComponent.registerRoutes(http, createAuth, { cors: true });

// Generates a persona reply, streaming it back in the response body while the
// persistentTextStreaming component persists it for every other viewer (see services/turn.ts's
// getTurnStream). Called by whichever tab first sees the turn as claimable; claimTurn lets
// exactly one of them through, and the rest get 409 and follow the persisted copy. The client
// sends its JSON body as text/plain, which keeps this a CORS "simple" request with no
// preflight -- so there's no OPTIONS route, just the header that lets the page read the body.
// "*" is safe: nothing here reads cookies or credentials.
http.route({
	path: "/turn-stream",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const { streamId } = (await request.json()) as { streamId: string };
		const turn = await ctx.runMutation(internal.api.turn.claimTurn, {
			streamId,
		});
		const response = turn
			? await streaming.stream(
					ctx,
					request,
					streamId as StreamId,
					(ctx, _request, _streamId, append) => runTurn(ctx, turn, append),
				)
			: new Response(null, { status: 409 });
		response.headers.set("Access-Control-Allow-Origin", "*");
		return response;
	}),
});

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
