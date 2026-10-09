import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptMessage } from "./llm";
import { classifyHarassment, personaReplyStream } from "./llm";

// Builds a non-streaming chat-completions Response carrying the given content.
function jsonResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status,
	});
}

// Builds an SSE Response from raw data lines.
function sseResponse(dataLines: string[], status = 200): Response {
	const body = dataLines.map((line) => `data: ${line}\n\n`).join("");
	return new Response(body, { status });
}

// Builds one streamed delta payload line for the given text.
function deltaLine(text: string | null): string {
	return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

const REPLY_JSON = JSON.stringify({
	reply: "Hi",
	introduce: [],
	sendFiles: [],
});

const REPLY_JSON_CHUNKS = [
	REPLY_JSON.slice(0, 10),
	REPLY_JSON.slice(10, 20),
	REPLY_JSON.slice(20),
];

// Collects every event emitted by personaReplyStream into an array.
async function drain(
	systemPrompt = NOOP_SYSTEM_PROMPT,
): Promise<{ type: string; text?: string }[]> {
	const events: { type: string; text?: string }[] = [];
	for await (const event of personaReplyStream(systemPrompt, []))
		events.push(event);
	return events;
}

beforeEach(() => {
	vi.stubEnv("LLM_KEY", "test-key");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("classifyHarassment (fail-open contract)", () => {
	// Tests that the classifier returns the NONSENSE label.
	it("labels NONSENSE", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("NONSENSE")));
		expect(await classifyHarassment("asdkjh", [])).toBe("nonsense");
	});

	// Tests that the classifier returns the NORMAL label.
	it("labels NORMAL", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("NORMAL")));
		expect(await classifyHarassment("hi", [])).toBe("normal");
	});

	// Tests that an unrecognized classifier label defaults to normal.
	it("defaults an unrecognized label to normal", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("BANANA")));
		expect(await classifyHarassment("hi", [])).toBe("normal");
	});

	// Tests that a failed classifier call falls back to normal so an outage never blocks a student.
	it("falls back to normal when the classifier call itself fails -- an outage must never block a student", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("upstream is down")),
		);
		expect(await classifyHarassment("hi", [])).toBe("normal");
	});

	// Tests that the classifier label parsing ignores case and surrounding whitespace.
	it("is case- and whitespace-insensitive", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse("  nonsense  ")),
		);
		expect(await classifyHarassment("hi", [])).toBe("nonsense");
	});

	// Tests that an empty conversation is formatted as a placeholder in the classifier prompt.
	it("formats an empty conversation as a placeholder in the classifier prompt", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse("NORMAL"));
		vi.stubGlobal("fetch", fetchMock);
		await classifyHarassment("hi", []);
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(body.messages[1].content).toContain("No conversation yet.");
	});

	// Tests that conversation turns are formatted as 'role: content' lines.
	it("formats conversation turns as 'role: content' lines", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse("NORMAL"));
		vi.stubGlobal("fetch", fetchMock);
		const conversation: TranscriptMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		];
		await classifyHarassment("hi", conversation);
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(body.messages[1].content).toContain("user: hi\nassistant: hello");
	});
});

const NOOP_SYSTEM_PROMPT = { cacheable: "system", dynamic: "" };

describe("personaReplyStream", () => {
	// Tests that reply text deltas are yielded in order.
	it("yields text deltas in order", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					sseResponse([
						deltaLine(REPLY_JSON.slice(0, 5)),
						deltaLine(REPLY_JSON.slice(5)),
						"[DONE]",
					]),
				),
		);
		const events = [];
		for await (const event of personaReplyStream(NOOP_SYSTEM_PROMPT, [
			{ role: "user", content: "hi" },
		]))
			events.push(event);
		expect(events).toEqual([
			{ type: "delta", text: REPLY_JSON.slice(0, 5) },
			{ type: "delta", text: REPLY_JSON.slice(5) },
		]);
	});

	// Tests that the reply request caps reasoning effort so it does not eat into the attempt timeout.
	it("caps reasoning effort -- Sonnet 5.5 mandates reasoning (enabled:false is a 400), so keep it low to stay inside the 30s attempt timeout", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(sseResponse([deltaLine(REPLY_JSON), "[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		await drain();
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(body.reasoning).toEqual({ effort: "low" });
	});

	// Tests that streamed delta lines with no text content are skipped.
	it("skips delta lines with no text content", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					sseResponse([deltaLine(null), deltaLine(REPLY_JSON), "[DONE]"]),
				),
		);
		const events = [];
		for await (const event of personaReplyStream(NOOP_SYSTEM_PROMPT, []))
			events.push(event);
		expect(events).toEqual([{ type: "delta", text: REPLY_JSON }]);
	});

	// Tests that a transient connection failure is retried before any text has streamed.
	it("retries a transient connection failure before any text has streamed", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("network error"))
			.mockResolvedValueOnce(sseResponse([deltaLine(REPLY_JSON), "[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		const events = [];
		for await (const event of personaReplyStream(NOOP_SYSTEM_PROMPT, []))
			events.push(event);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events).toEqual([{ type: "delta", text: REPLY_JSON }]);
	});

	// Tests that a retryable HTTP status (429/5xx) is retried before any text has streamed.
	it("retries a retryable HTTP status (429/5xx) before any text has streamed", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
			.mockResolvedValueOnce(sseResponse([deltaLine(REPLY_JSON), "[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		const events = [];
		for await (const event of personaReplyStream(NOOP_SYSTEM_PROMPT, []))
			events.push(event);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events).toEqual([{ type: "delta", text: REPLY_JSON }]);
	});

	// Tests that a non-retryable HTTP status is retried once and then fails with that status.
	it("retries a non-retryable HTTP status once, then fails with it", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => new Response("bad", { status: 400 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(drain()).rejects.toThrow(/HTTP 400/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// Tests that a stream that ends with no content is retried.
	it("retries a stream that ends with no content", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				sseResponse([
					JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
					"[DONE]",
				]),
			)
			.mockResolvedValueOnce(sseResponse([deltaLine(REPLY_JSON), "[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		expect(await drain()).toEqual([{ type: "delta", text: REPLY_JSON }]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// Tests that a stream truncated mid-JSON is retried after telling the consumer to reset.
	it("retries a stream truncated mid-JSON, telling the consumer to reset first", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				sseResponse([
					deltaLine(REPLY_JSON.slice(0, 12)),
					JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
					"[DONE]",
				]),
			)
			.mockResolvedValueOnce(sseResponse([deltaLine(REPLY_JSON), "[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		expect(await drain()).toEqual([
			{ type: "delta", text: REPLY_JSON.slice(0, 12) },
			{ type: "reset" },
			{ type: "delta", text: REPLY_JSON },
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// Tests that an error frame inside a 200 stream is treated as a failure and retried.
	it("retries when OpenRouter puts an error frame in a 200 stream", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				sseResponse([
					JSON.stringify({ error: { code: 502, message: "upstream" } }),
					"[DONE]",
				]),
			)
			.mockResolvedValueOnce(sseResponse([deltaLine(REPLY_JSON), "[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		expect(await drain()).toEqual([{ type: "delta", text: REPLY_JSON }]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// Tests that the turn fails when every attempt ends empty or truncated.
	it("fails the turn when every attempt ends empty or truncated", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => sseResponse(["[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		await expect(drain()).rejects.toThrow(/no content/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// Tests that a failure after text has already streamed is not retried and fails the turn.
	it("does NOT retry once text has already streamed -- it fails the turn instead", async () => {
		let pulls = 0;
		const brokenBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) {
					controller.enqueue(
						new TextEncoder().encode(`data: ${deltaLine("Partial")}\n\n`),
					);
					return;
				}
				controller.error(new Error("connection reset mid-stream"));
			},
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(brokenBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			)
			.mockResolvedValueOnce(
				sseResponse([deltaLine("A different reply"), "[DONE]"]),
			);
		vi.stubGlobal("fetch", fetchMock);

		const events: unknown[] = [];
		await expect(
			(async () => {
				for await (const event of personaReplyStream(NOOP_SYSTEM_PROMPT, []))
					events.push(event);
			})(),
		).rejects.toThrow(/connection reset mid-stream/);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events).toEqual([{ type: "delta", text: "Partial" }]);
	});

	// Tests that a response body that stalls after the headers is aborted instead of hanging.
	it("aborts a response whose body stalls after the headers, instead of hanging forever", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
				const signal = init.signal as AbortSignal;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(`data: ${deltaLine("Partial")}\n\n`),
						);
						signal.addEventListener("abort", () =>
							controller.error(new Error("The operation was aborted.")),
						);
					},
				});
				return new Response(body, { status: 200 });
			});
			vi.stubGlobal("fetch", fetchMock);

			const events: unknown[] = [];
			const consumed = (async () => {
				for await (const event of personaReplyStream(NOOP_SYSTEM_PROMPT, []))
					events.push(event);
			})();
			const assertion = expect(consumed).rejects.toThrow(/abort/i);

			await vi.advanceTimersByTimeAsync(35_000);
			await assertion;
			expect(events).toEqual([{ type: "delta", text: "Partial" }]);
		} finally {
			vi.useRealTimers();
		}
	});

	// Tests that a slow but progressing stream that finishes within the budget is not aborted.
	it("does not abort a slow-but-progressing stream that completes within the budget", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					let pulls = 0;
					const body = new ReadableStream<Uint8Array>({
						async pull(controller) {
							pulls += 1;
							if (pulls > 3) {
								controller.close();
								return;
							}
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${deltaLine(REPLY_JSON_CHUNKS[pulls - 1] ?? "")}\n\n`,
								),
							);
						},
					});
					return new Response(body, { status: 200 });
				}),
			);

			const events: { text: string }[] = [];
			const consumed = (async () => {
				for await (const event of personaReplyStream(NOOP_SYSTEM_PROMPT, []))
					events.push(event as { text: string });
			})();
			await vi.advanceTimersByTimeAsync(1_000);
			await consumed;

			expect(events.map((e) => e.text)).toEqual(REPLY_JSON_CHUNKS);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
