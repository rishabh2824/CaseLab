// The shared Mock Service Worker server every unit test talks to.
//
// Registered from both setup files with `onUnhandledRequest: "error"`, which
// is the point: a test that reaches for an endpoint nobody stubbed fails loudly
// instead of hanging on a real socket, and a production code path that starts
// calling a new endpoint fails the test that never knew about it.
import { setupServer } from "msw/node";

export { type SseFrame, sseBody } from "./sse.js";

export const server = setupServer();

// An SSE Response whose body arrives in separate chunks with an optional delay
// between them — the only way to prove incremental rendering and streamChat's
// idle timeout actually work, since a single-shot string body resolves the
// whole stream in one `reader.read()`.
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
