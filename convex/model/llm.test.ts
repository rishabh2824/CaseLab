import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePersonaReply, PERSONA_REPLY_RETRIES } from "./llm";

// Builds a non-streaming chat-completions Response carrying the given content.
function jsonResponse(content: string, status = 200): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status,
	});
}

const REPLY = {
	reply: "Hi",
	introduce: ["R1"],
	sendFiles: [] as string[],
	flag: "none",
};
const REPLY_JSON = JSON.stringify(REPLY);
const SYSTEM_PROMPT = { cacheable: "cacheable part", dynamic: "dynamic part" };

beforeEach(() => {
	vi.stubEnv("LLM_KEY", "test-key");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
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
