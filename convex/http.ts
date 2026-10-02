import type { StreamId } from "@convex-dev/persistent-text-streaming";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { streaming } from "./lib/streaming";
import { studentErrorData } from "./lib/studentErrors";
import { type ClaimedTurn, runTurn } from "./services/turn";

const http = httpRouter();
authComponent.registerRoutes(http, createAuth, { cors: true });

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Expose-Headers": "X-Stream-Id",
};

// Starts a turn for the student's message and streams the persona's reply back, or answers 400 with the student error.
http.route({
	path: "/turn-stream",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const args = (await request.json()) as {
			runId: Id<"runs">;
			personaId: string;
			message: string;
		};
		let turn: ClaimedTurn;
		try {
			turn = await ctx.runMutation(internal.api.turn.start, args);
		} catch (err) {
			const error = studentErrorData(err);
			if (!error) throw err;
			return new Response(JSON.stringify(error), {
				status: 400,
				headers: { "Content-Type": "application/json", ...CORS_HEADERS },
			});
		}
		const response = await streaming.stream(
			ctx,
			request,
			turn.streamId as StreamId,
			(ctx, _request, _streamId, append) => runTurn(ctx, turn, append),
		);
		for (const [name, value] of Object.entries(CORS_HEADERS))
			response.headers.set(name, value);
		response.headers.set("X-Stream-Id", turn.streamId);
		return response;
	}),
});

registerStaticRoutes(http, components.staticHosting);

export default http;
