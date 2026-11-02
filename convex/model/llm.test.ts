import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptMessage } from "./llm";
import {
	classifyMessage,
	generatePersonaReply,
	PERSONA_REPLY_RETRIES,
} from "./llm";

// Builds a non-streaming chat-completions Response carrying the given content.
function jsonResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status,
	});
}

// Builds the JSON text the classifier is constrained to return.
function label(value: string): string {
	return JSON.stringify({ label: value });
}

const REPLY = { reply: "Hi", introduce: ["R1"], sendFiles: [] as string[] };
const REPLY_JSON = JSON.stringify(REPLY);
const SYSTEM_PROMPT = { cacheable: "cacheable part", dynamic: "dynamic part" };

beforeEach(() => {
	vi.stubEnv("LLM_KEY", "test-key");
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("classifyMessage (fail-open contract)", () => {
	// Tests that the classifier returns the flagged label.
	it("labels flagged", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse(label("flagged"))),
		);
		expect(await classifyMessage("asdkjh", [])).toBe("flagged");
	});

	// Tests that the classifier returns the ok label.
	it("labels ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse(label("ok"))),
		);
		expect(await classifyMessage("hi", [])).toBe("ok");
	});

	// Tests that an unexpected label never flags a student.
	it("treats an unexpected label as ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse(label("banana"))),
		);
		expect(await classifyMessage("hi", [])).toBe("ok");
	});

	// Tests that an answer that isn't JSON falls back to ok.
	it("falls back to ok when the answer is not JSON", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("FLAGGED")));
		expect(await classifyMessage("hi", [])).toBe("ok");
	});

	// Tests that a failed classifier call falls back to ok so an outage never blocks a student.
	it("falls back to ok when the classifier call itself fails -- an outage must never block a student", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("upstream is down")),
		);
		expect(await classifyMessage("hi", [])).toBe("ok");
	});

	// Tests that an upstream error status falls back to ok.
	it("falls back to ok on an upstream error status", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("", 503)));
		expect(await classifyMessage("hi", [])).toBe("ok");
	});

	// Tests that a response with no choices falls back to ok.
	it("falls back to ok when the response has no choices", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }))),
		);
		expect(await classifyMessage("hi", [])).toBe("ok");
	});

	// Tests that the request constrains the answer to the two labels through a strict JSON schema.
	it("constrains the answer to the two labels with a strict JSON schema", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(label("ok")));
		vi.stubGlobal("fetch", fetchMock);
		await classifyMessage("hi", []);
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(body.stream).toBeUndefined();
		expect(body.response_format.json_schema).toMatchObject({
			strict: true,
			schema: {
				properties: { label: { enum: ["ok", "flagged"] } },
				required: ["label"],
			},
		});
	});

	// Tests that an empty conversation is formatted as a placeholder in the classifier prompt.
	it("formats an empty conversation as a placeholder in the classifier prompt", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(label("ok")));
		vi.stubGlobal("fetch", fetchMock);
		await classifyMessage("hi", []);
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(body.messages[1].content).toContain("No conversation yet.");
	});

	// Tests that conversation turns are formatted as 'role: content' lines.
	it("formats conversation turns as 'role: content' lines", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(label("ok")));
		vi.stubGlobal("fetch", fetchMock);
		const conversation: TranscriptMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		];
		await classifyMessage("hi", conversation);
		const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
		expect(body.messages[1].content).toContain("user: hi\nassistant: hello");
	});
});

describe("generatePersonaReply", () => {
	// Tests that a valid response is parsed into the reply and its handle lists.
	it("returns the parsed reply and handle lists", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(REPLY_JSON)));
		expect(await generatePersonaReply(SYSTEM_PROMPT, [])).toEqual(REPLY);
	});

	// Tests that the request is a plain call with a strict schema, a cacheable system block and the pinned provider.
	it("makes a non-streaming call with a strict schema and a pinned provider", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(REPLY_JSON));
		vi.stubGlobal("fetch", fetchMock);
		await generatePersonaReply(SYSTEM_PROMPT, [
			{ role: "user", content: "hello" },
		]);

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(init.headers.Authorization).toBe("Bearer test-key");
		const body = JSON.parse(init.body as string);
		expect(body.stream).toBeUndefined();
		expect(body.response_format.json_schema).toMatchObject({
			name: "persona_reply",
			strict: true,
		});
		expect(body.provider).toEqual({
			order: ["anthropic"],
			allow_fallbacks: false,
		});
		expect(body.messages[0].content).toEqual([
			{
				type: "text",
				text: "cacheable part",
				cache_control: { type: "ephemeral" },
			},
			{ type: "text", text: "dynamic part" },
		]);
		expect(body.messages[1]).toEqual({ role: "user", content: "hello" });
	});

	// Tests that a failed attempt is retried and the later attempt's reply is returned.
	it("retries a failed attempt", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse("", 503))
			.mockResolvedValueOnce(jsonResponse(REPLY_JSON));
		vi.stubGlobal("fetch", fetchMock);
		expect(await generatePersonaReply(SYSTEM_PROMPT, [])).toEqual(REPLY);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// Tests that a truncated generation is retried like any other failed attempt.
	it("retries a truncated generation", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(REPLY_JSON.slice(0, 12)))
			.mockResolvedValueOnce(jsonResponse(REPLY_JSON));
		vi.stubGlobal("fetch", fetchMock);
		expect(await generatePersonaReply(SYSTEM_PROMPT, [])).toEqual(REPLY);
	});

	// Tests that a response with no content is a failed attempt.
	it("treats a response with no content as a failure", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(
				async () => new Response(JSON.stringify({ choices: [] })),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(generatePersonaReply(SYSTEM_PROMPT, [])).rejects.toThrow(
			/no content/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(PERSONA_REPLY_RETRIES);
	});

	// Tests that the last attempt's error is thrown once the retries are used up.
	it("throws after the retries are used up", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse("", 502));
		vi.stubGlobal("fetch", fetchMock);
		await expect(generatePersonaReply(SYSTEM_PROMPT, [])).rejects.toThrow(
			/HTTP 502/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(PERSONA_REPLY_RETRIES);
	});

	// Tests that a network failure is retried and then surfaced.
	it("retries a network failure and then surfaces it", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(generatePersonaReply(SYSTEM_PROMPT, [])).rejects.toThrow(
			"ECONNRESET",
		);
		expect(fetchMock).toHaveBeenCalledTimes(PERSONA_REPLY_RETRIES);
	});

	// Tests that the provider URL defaults to OpenRouter and can be overridden by LLM_BASE_URL.
	it("posts to OpenRouter by default and to LLM_BASE_URL when it is set", async () => {
		const fetchMock = vi.fn(async (_url: string) => jsonResponse(REPLY_JSON));
		vi.stubGlobal("fetch", fetchMock);

		await generatePersonaReply(SYSTEM_PROMPT, []);
		expect(fetchMock.mock.calls[0]![0]).toBe(
			"https://openrouter.ai/api/v1/chat/completions",
		);

		vi.stubEnv("LLM_BASE_URL", "http://127.0.0.1:4010/v1");
		await generatePersonaReply(SYSTEM_PROMPT, []);
		expect(fetchMock.mock.calls[1]![0]).toBe(
			"http://127.0.0.1:4010/v1/chat/completions",
		);
	});
});
