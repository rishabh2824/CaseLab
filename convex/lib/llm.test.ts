import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "./llm";
import { classifyHarassment, personaReplyStream } from "./llm";

function jsonResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status,
	});
}

// Encodes a sequence of already-formatted SSE `data: ...` lines as one streamed response body,
// mirroring what OpenRouter's chat/completions endpoint sends with `stream: true`.
function sseResponse(dataLines: string[], status = 200): Response {
	const body = dataLines.map((line) => `data: ${line}\n\n`).join("");
	return new Response(body, { status });
}

function deltaLine(text: string | null): string {
	return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

// personaReplyStream now rejects a stream whose accumulated text isn't valid JSON, so fixtures
// that stand in for a successful generation must be one.
const REPLY_JSON = JSON.stringify({
	reply: "Hi",
	introduce: [],
	send_files: [],
});

const REPLY_JSON_CHUNKS = [
	REPLY_JSON.slice(0, 10),
	REPLY_JSON.slice(10, 20),
	REPLY_JSON.slice(20),
];

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
	it("labels NONSENSE", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("NONSENSE")));
		expect(await classifyHarassment("asdkjh", [])).toBe("nonsense");
	});

	it("labels NORMAL", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("NORMAL")));
		expect(await classifyHarassment("hi", [])).toBe("normal");
	});

	it("defaults an unrecognized label to normal", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("BANANA")));
		expect(await classifyHarassment("hi", [])).toBe("normal");
	});

	it("falls back to normal when the classifier call itself fails -- an outage must never block a student", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("upstream is down")),
		);
		expect(await classifyHarassment("hi", [])).toBe("normal");
	});

	it("is case- and whitespace-insensitive", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse("  nonsense  ")),
		);
		expect(await classifyHarassment("hi", [])).toBe("nonsense");
	});

	it("formats an empty conversation as a placeholder in the classifier prompt", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse("NORMAL"));
		vi.stubGlobal("fetch", fetchMock);
		await classifyHarassment("hi", []);
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(body.messages[1].content).toContain("No conversation yet.");
	});

	it("formats conversation turns as 'role: content' lines and skips system turns", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse("NORMAL"));
		vi.stubGlobal("fetch", fetchMock);
		const conversation: ChatMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		];
		await classifyHarassment("hi", conversation);
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(body.messages[1].content).toContain("user: hi\nassistant: hello");
		expect(body.messages[1].content).not.toContain("sys");
	});
});

// Cache boundary content is irrelevant to every test below -- they only care about how the
// SSE response is processed, not what was sent -- so one fixed stand-in covers every call.
const NOOP_SYSTEM_PROMPT = { cacheable: "system", dynamic: "" };

describe("personaReplyStream", () => {
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

	it("retries a non-retryable HTTP status once, then fails with it", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => new Response("bad", { status: 400 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(drain()).rejects.toThrow(/HTTP 400/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

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

	it("fails the turn when every attempt ends empty or truncated", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => sseResponse(["[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		await expect(drain()).rejects.toThrow(/no content/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// The retry policy is only safe because it never restarts a generation that already emitted
	// text: a second attempt produces a completely different reply, so resuming would splice two
	// generations together -- the caller (services/turn.ts's runTurn) accumulates every delta
	// into one `fullText` it then parses as a single JSON object, which two concatenated
	// generations can never be. Failing the turn is the correct outcome; a duplicated or
	// half-spliced reply reaching the student is not. Mutating the `!yieldedAny` guard away left
	// the whole suite green, so this is the only thing holding that boundary.
	it("does NOT retry once text has already streamed -- it fails the turn instead", async () => {
		// Errors on the SECOND pull, not in start(): erroring a controller clears its queue, so
		// enqueue-then-error synchronously would drop the chunk and never deliver a delta at all
		// -- which is the "nothing streamed yet" case that legitimately DOES retry.
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

	// A provider that returns headers and then stalls used to have NO timeout: the abort timer
	// was disarmed the moment fetch resolved, which for a streamed response is before a single
	// byte of body has arrived. The turn would hang until the platform killed the scheduled
	// action -- which skips runTurn's catch, so markStreamingError never runs and the persona's
	// streaming row stays "streaming" forever, locking that contact for the rest of the run.
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
						// ...and then nothing else, ever, unless the caller's own deadline fires.
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

			// Past the per-attempt budget (30s). Without the deadline covering the body, this
			// advance changes nothing and the promise never settles.
			await vi.advanceTimersByTimeAsync(35_000);
			await assertion;
			expect(events).toEqual([{ type: "delta", text: "Partial" }]);
		} finally {
			vi.useRealTimers();
		}
	});

	// The flip side: the deadline must not fire for a stream that simply takes a while but keeps
	// producing, and must be disarmed once the stream ends normally.
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
			// The timer is released on the normal exit path too -- an un-disarmed timer would
			// still be pending here and fire into a completed request.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
