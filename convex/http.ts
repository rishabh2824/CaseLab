import type { StreamId } from "@convex-dev/persistent-text-streaming";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { streaming } from "./lib/streaming";
import { runTurn } from "./services/turn";

const http = httpRouter();
authComponent.registerRoutes(http, createAuth, { cors: true });

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

registerStaticRoutes(http, components.staticHosting);

export default http;
