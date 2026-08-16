// Shared SSE-framing helper — serializes frames the way sse-starlette does on
// the wire, so both the vitest unit suite (via msw.ts) and the Playwright e2e
// suite (via e2e/mockApi.ts) exercise streamChat's parser against the same
// real framing. `event:` is omitted for an unnamed frame, matching a bare
// `data:`-only message.
export type SseFrame = { event?: string; data: unknown };

export function sseBody(frames: SseFrame[]): string {
	return `${frames
		.map(({ event, data }) =>
			[event ? `event: ${event}` : null, `data: ${JSON.stringify(data)}`]
				.filter((line) => line !== null)
				.join("\n"),
		)
		.join("\n\n")}\n\n`;
}
