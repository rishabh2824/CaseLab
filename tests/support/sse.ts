export type SseFrame = { event?: string; data: unknown };

// Formats frames as an SSE body with optional event names and JSON data lines.
export function sseBody(frames: SseFrame[]): string {
	return `${frames
		.map(({ event, data }) =>
			[event ? `event: ${event}` : null, `data: ${JSON.stringify(data)}`]
				.filter((line) => line !== null)
				.join("\n"),
		)
		.join("\n\n")}\n\n`;
}
