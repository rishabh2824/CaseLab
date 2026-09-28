import { setupServer } from "msw/node";

export { type SseFrame, sseBody } from "./sse.js";

export const server = setupServer();

// Builds a streaming SSE Response that emits the chunks, optionally with a delay between them.
export function sseStreamResponse(
	chunks: string[],
	{ delayMs = 0 }: { delayMs?: number } = {},
): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				if (delayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}
