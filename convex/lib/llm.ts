const LLM_BASE_URL = "https://openrouter.ai/api/v1";
const LLM_MODEL = "anthropic/claude-sonnet-5.5";
const LLM_CLASSIFIER_MODEL = "anthropic/claude-haiku-5.5";

export const LLM_ATTEMPT_TIMEOUT_MS = 10_000;
const CLASSIFIER_TIMEOUT_MS = 6_000;
export const PERSONA_REPLY_RETRIES = 2;

// Returns the LLM API key from the environment, throwing if it is missing.
function requireLlmKey(): string {
	const key = process.env.LLM_KEY;
	if (!key) throw new Error("Missing required environment variable: LLM_KEY");
	return key;
}

export type TranscriptMessage = {
	role: "user" | "assistant";
	content: string;
};

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

// Fetches a URL with an abort timeout that stays armed until the caller releases it.
async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<{ response: Response; release: () => void }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		return { response, release: () => clearTimeout(timer) };
	} catch (err) {
		clearTimeout(timer);
		throw err;
	}
}

// POSTs a chat-completions request to the LLM provider with the API key attached.
async function postChatCompletions(
	body: unknown,
	timeoutMs: number,
): Promise<{ response: Response; release: () => void }> {
	return await fetchWithTimeout(
		`${LLM_BASE_URL}/chat/completions`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${requireLlmKey()}`,
			},
			body: JSON.stringify(body),
		},
		timeoutMs,
	);
}

// Makes a non-streaming chat call and returns the reply text.
async function chat(options: {
	model: string;
	messages: ChatMessage[];
	maxTokens: number;
	timeoutMs: number;
	temperature?: number;
}): Promise<string> {
	const body: Record<string, unknown> = {
		model: options.model,
		messages: options.messages,
		max_tokens: options.maxTokens,
		provider: { order: ["anthropic"], allow_fallbacks: false },
	};
	if (options.temperature !== undefined) body.temperature = options.temperature;

	const { response, release } = await postChatCompletions(
		body,
		options.timeoutMs,
	);
	try {
		if (!response.ok)
			throw new Error(`LLM request failed (HTTP ${response.status}).`);
		const data = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return data.choices?.[0]?.message?.content ?? "";
	} finally {
		release();
	}
}

export const PERSONA_REPLY_SCHEMA = {
	type: "object",
	properties: {
		reply: { type: "string", description: "In-character reply text." },
		introduce: {
			type: "array",
			items: { type: "string" },
			description: "Contact handles introduced in this reply.",
		},
		sendFiles: {
			type: "array",
			items: { type: "string" },
			description: "File handles sent with this reply.",
		},
	},
	required: ["reply", "introduce", "sendFiles"],
	additionalProperties: false,
};

export type StreamDelta = { type: "delta"; text: string } | { type: "reset" };

class StreamRetryError extends Error {}

// Streams a persona's JSON reply, retrying failed attempts and emitting a reset when a retry discards streamed text.
export async function* personaReplyStream(
	systemPrompt: { cacheable: string; dynamic: string },
	history: ChatMessage[],
): AsyncGenerator<StreamDelta> {
	const body = {
		model: LLM_MODEL,
		messages: [
			{
				role: "system",
				content: [
					{
						type: "text",
						text: systemPrompt.cacheable,
						cache_control: { type: "ephemeral" },
					},
					{ type: "text", text: systemPrompt.dynamic },
				],
			},
			...history,
		],
		max_tokens: 1000,
		temperature: 0.4,
		stream: true,
		response_format: {
			type: "json_schema",
			json_schema: {
				name: "persona_reply",
				strict: true,
				schema: PERSONA_REPLY_SCHEMA,
			},
		},
		provider: { order: ["anthropic"], allow_fallbacks: false },
		reasoning: { effort: "low" },
	};

	for (let attempt = 1; attempt <= PERSONA_REPLY_RETRIES; attempt++) {
		const canRetry = attempt < PERSONA_REPLY_RETRIES;
		let response: Response;
		let release: () => void;
		try {
			({ response, release } = await postChatCompletions(
				body,
				LLM_ATTEMPT_TIMEOUT_MS,
			));
		} catch (err) {
			if (canRetry) continue;
			throw err;
		}
		if (!response.ok || !response.body) {
			release();
			if (canRetry) continue;
			throw new Error(`LLM request failed (HTTP ${response.status}).`);
		}

		let yieldedAny = false;
		let attemptText = "";
		let finishReason: string | null = null;
		const assertUsableAttempt = () => {
			if (!attemptText)
				throw new StreamRetryError(
					`LLM stream ended with no content (finish_reason: ${finishReason}).`,
				);
			try {
				JSON.parse(attemptText);
			} catch {
				throw new StreamRetryError(
					`LLM stream ended with truncated or invalid JSON (finish_reason: ${finishReason}).`,
				);
			}
		};
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					assertUsableAttempt();
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) continue;
					const payload = trimmed.slice("data:".length).trim();
					if (payload === "[DONE]") {
						assertUsableAttempt();
						return;
					}
					let parsed: {
						error?: unknown;
						choices?: {
							delta?: { content?: string };
							finish_reason?: string | null;
						}[];
					};
					try {
						parsed = JSON.parse(payload);
					} catch {
						continue;
					}
					if (parsed.error)
						throw new StreamRetryError(
							`LLM stream error frame: ${JSON.stringify(parsed.error).slice(0, 300)}`,
						);
					finishReason = parsed.choices?.[0]?.finish_reason ?? finishReason;
					const text = parsed.choices?.[0]?.delta?.content;
					if (text) {
						yieldedAny = true;
						attemptText += text;
						yield { type: "delta", text };
					}
				}
			}
		} catch (err) {
			if (canRetry && (!yieldedAny || err instanceof StreamRetryError)) {
				if (yieldedAny) yield { type: "reset" };
				continue;
			}
			throw err;
		} finally {
			release();
		}
	}
}

export const RECENT_HISTORY_LIMIT = 10;

// Formats the conversation, already limited to the recent turns, as 'role: content' lines.
function formatTranscript(conversation: TranscriptMessage[]): string {
	const lines = conversation.map(
		(message) => `${message.role}: ${message.content}`,
	);
	return lines.length > 0 ? lines.join("\n") : "No conversation yet.";
}

export type HarassmentLabel = "normal" | "nonsense";

// Classifies the latest student message as normal or nonsense, defaulting to normal if the call fails.
export async function classifyHarassment(
	userMessage: string,
	conversation: TranscriptMessage[],
): Promise<HarassmentLabel> {
	const transcript = formatTranscript(conversation);
	const systemPrompt =
		"You are a strict conversation safety classifier for a case simulation. " +
		"Classify the latest user message in context. " +
		"Return ONLY one label from this set: NORMAL, NONSENSE.\n" +
		"Use NONSENSE for spam, gibberish, or repeatedly incoherent case-irrelevant " +
		"input, AND for rude, insulting, harassing, or abusive messages, including " +
		"explicit threats or severe abuse — anything that isn't a normal, coherent, " +
		"case-related message.\n" +
		"Otherwise return NORMAL.";
	const userPrompt = `Recent conversation:\n${transcript}\n\nLatest user message:\n${userMessage}`;

	let raw: string;
	try {
		raw = await chat({
			model: LLM_CLASSIFIER_MODEL,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
			temperature: 0,
			maxTokens: 50,
			timeoutMs: CLASSIFIER_TIMEOUT_MS,
		});
	} catch {
		return "normal";
	}
	return raw.trim().toUpperCase().startsWith("NONSENSE")
		? "nonsense"
		: "normal";
}
