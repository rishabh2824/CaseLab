import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHarassment, personaReplyStream } from "./llm";
import type { ChatMessage } from "./llm";

function jsonResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
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
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream is down")));
		expect(await classifyHarassment("hi", [])).toBe("normal");
	});

	it("is case- and whitespace-insensitive", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("  nonsense  ")));
		expect(await classifyHarassment("hi", [])).toBe("nonsense");
	});

	it("formats an empty conversation as a placeholder in the classifier prompt", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse("NORMAL"));
		vi.stubGlobal("fetch", fetchMock);
		await classifyHarassment("hi", []);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
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
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body.messages[1].content).toContain("user: hi\nassistant: hello");
		expect(body.messages[1].content).not.toContain("sys");
	});
});

describe("personaReplyStream", () => {
	it("yields text deltas in order", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(sseResponse([deltaLine("Hello"), deltaLine(" there."), "[DONE]"])),
		);
		const events = [];
		for await (const event of personaReplyStream([{ role: "user", content: "hi" }])) events.push(event);
		expect(events).toEqual([
			{ type: "delta", text: "Hello" },
			{ type: "delta", text: " there." },
		]);
	});

	it("skips delta lines with no text content", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([deltaLine(null), deltaLine("Hi"), "[DONE]"])));
		const events = [];
		for await (const event of personaReplyStream([])) events.push(event);
		expect(events).toEqual([{ type: "delta", text: "Hi" }]);
	});

	it("retries a transient connection failure before any text has streamed", async () => {
		const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("network error")).mockResolvedValueOnce(
			sseResponse([deltaLine("Recovered"), "[DONE]"]),
		);
		vi.stubGlobal("fetch", fetchMock);
		const events = [];
		for await (const event of personaReplyStream([])) events.push(event);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events).toEqual([{ type: "delta", text: "Recovered" }]);
	});

	it("retries a retryable HTTP status (429/5xx) before any text has streamed", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
			.mockResolvedValueOnce(sseResponse([deltaLine("Recovered"), "[DONE]"]));
		vi.stubGlobal("fetch", fetchMock);
		const events = [];
		for await (const event of personaReplyStream([])) events.push(event);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events).toEqual([{ type: "delta", text: "Recovered" }]);
	});

	it("does not retry a non-retryable HTTP status", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
		await expect((async () => {
			for await (const _ of personaReplyStream([])) {
				/* drain */
			}
		})()).rejects.toThrow(/HTTP 400/);
	});
});
