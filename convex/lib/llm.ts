// Raw fetch against OpenRouter's OpenAI-compatible API instead of the `openai` SDK: the
// SDK's Convex-runtime story (default V8 isolate vs. "use node") is an open question, and
// fetch sidesteps it entirely (no "use node" needed, works in the default runtime, no Node
// cold start) while also dropping a dependency.

const LLM_BASE_URL = "https://openrouter.ai/api/v1";
const LLM_MODEL = "anthropic/claude-sonnet-5";
const LLM_CLASSIFIER_MODEL = "anthropic/claude-haiku-4.5";

// See personaReplyStream's own comment for how these relate (LLM_ATTEMPT_TIMEOUT_MS *
// PERSONA_REPLY_RETRIES is the worst case before it gives up). Exported so services/turn.ts's
// claimStreamingSlot can derive its stuck-row staleness threshold from the same worst case,
// instead of a second, independently-chosen number that could silently stop matching this one.
export const LLM_ATTEMPT_TIMEOUT_MS = 30_000;
export const PERSONA_REPLY_RETRIES = 2;

function requireLlmKey(): string {
	const key = process.env.LLM_KEY;
	if (!key) throw new Error("Missing required environment variable: LLM_KEY");
	return key;
}

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

// Resolves once response HEADERS arrive, and hands back a `release` the caller must invoke when
// it is genuinely finished with the response -- immediately for a buffered call, but only after
// the last chunk for a streamed body.
//
// Disarming the abort in a `finally` around `fetch` alone (the obvious shape) leaves a streamed
// body with no timeout at all, since fetch resolves at the headers. A provider that sends
// headers and then stalls would hang the whole scheduled action, and that hang is not benign:
// the platform eventually kills the action WITHOUT running runTurn's catch, so markStreamingError
// never fires and the persona's streamingReplies row is left at status "streaming" forever --
// which claimStreamingSlot (services/turn.ts) reads as "a turn is already in flight", bricking
// that contact for the remainder of the run. Keeping the timer armed across the read loop makes
// timeoutMs a deadline for the entire attempt, which is what the retry budget already assumed.
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

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

// Shared by chat() and personaReplyStream() below -- both POST to the same endpoint with the
// same headers/auth, and differ only in the request body (buffered vs. streamed, and which
// model/schema) and the timeout budget. Pure extraction of that identical construction; no
// behavior change.
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

// Its only caller is classifyHarassment, a temperature=0 classification gate -- pin routing
// to Anthropic directly so identical inputs aren't put through whatever upstream OpenRouter
// happens to pick for a given request.
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

// Schema the persona reply is constrained to (structured outputs). reply/introduce/
// send_files are generated as ONE schema-constrained JSON object -- the provider's
// constrained decoding guarantees introduce/send_files are always present and consistent
// with the same generation that produced reply, unlike an optional, separately-decided tool
// call the model can simply skip or contradict. Descriptions here are deliberately terse
// field labels, not the full contract (lib/prompt.ts's replyInstructions() already states
// that in the prompt).
export const PERSONA_REPLY_SCHEMA = {
	type: "object",
	properties: {
		reply: { type: "string", description: "In-character reply text." },
		introduce: {
			type: "array",
			items: { type: "string" },
			description: "Contact handles introduced in this reply.",
		},
		send_files: {
			type: "array",
			items: { type: "string" },
			description: "File handles sent with this reply.",
		},
	},
	required: ["reply", "introduce", "send_files"],
	additionalProperties: false,
};

export type StreamDelta = { type: "delta"; text: string };

// Streaming persona reply. Yields {type: "delta", text} for each raw fragment of the
// schema-constrained JSON object as it streams -- the caller (services/turn.ts's runTurn)
// accumulates the full text and authoritatively parses it once the stream ends. Retries a
// fresh attempt (never resumes a partial one) up to PERSONA_REPLY_RETRIES times, but only if
// nothing has streamed yet and the failure looks transient (connection reset, timeout, 429,
// 5xx) -- once any text has streamed, silently restarting would risk duplicating/losing
// content, so the error is raised instead.
export async function* personaReplyStream(
	systemPrompt: { cacheable: string; dynamic: string },
	history: ChatMessage[],
): AsyncGenerator<StreamDelta> {
	const body = {
		model: LLM_MODEL,
		messages: [
			{
				role: "system",
				// Anthropic (via OpenRouter) caches everything up to and including a block marked
				// cache_control, at a 90% discount on every subsequent read within the (default
				// 5-minute) TTL -- and since the cache key is just a content hash, not scoped to
				// this conversation, every OTHER student concurrently talking to this same persona
				// hits it too. `dynamic` (redacted knownFacts, referral/file candidates -- see
				// prompt.ts's SystemPromptParts) stays in its own uncached block after the
				// breakpoint, since it changes as referrals unlock and would otherwise invalidate
				// the whole cached prefix on every turn.
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
		max_tokens: 600,
		// Explicit, not left at the provider default (1.0) -- a rare degenerate sample at 1.0
		// combines badly with strict schema-constrained decoding below: when a sampled token is
		// masked out by the JSON-schema grammar, the constrained sampler falls back into
		// whatever's left, which at high temperature produces word-fragment garbage inside an
		// otherwise-valid `reply` string rather than a clean retry-worthy failure.
		temperature: 0.7,
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
			if (canRetry && isRetryableStatus(response.status)) continue;
			throw new Error(`LLM request failed (HTTP ${response.status}).`);
		}

		let yieldedAny = false;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) continue;
					const payload = trimmed.slice("data:".length).trim();
					if (payload === "[DONE]") return;
					let parsed: { choices?: { delta?: { content?: string } }[] };
					try {
						parsed = JSON.parse(payload);
					} catch {
						continue;
					}
					const text = parsed.choices?.[0]?.delta?.content;
					if (text) {
						yieldedAny = true;
						yield { type: "delta", text };
					}
				}
			}
		} catch (err) {
			if (!yieldedAny && canRetry) continue;
			throw err;
		} finally {
			// Runs on every exit -- the `[DONE]`/end-of-stream returns above, a thrown error, and
			// the consumer abandoning the generator mid-stream (which resumes this function at
			// the `yield` with a return, so nothing after the loop would otherwise run).
			release();
		}
	}
	throw new Error("Persona reply stream failed after all retries.");
}

// Share the last few messages only instead of the full chat history -- one shared limit for
// both the harassment classifier's transcript below and the persona-reply prompt
// (services/turn.ts). Exported so turn.ts can also bound its db query to this same window,
// instead of fetching a persona's entire history just to discard most of it.
export const RECENT_HISTORY_LIMIT = 10;

// Formats the last `limit` non-system turns of a conversation as "role: content" lines.
function formatTranscript(
	conversation: ChatMessage[],
	limit = RECENT_HISTORY_LIMIT,
): { transcript: string; userCount: number; assistantCount: number } {
	const lines: string[] = [];
	let userCount = 0;
	let assistantCount = 0;
	for (const message of conversation.slice(-limit)) {
		if (message.role === "system") continue;
		lines.push(`${message.role}: ${message.content}`);
		if (message.role === "user") userCount += 1;
		else if (message.role === "assistant") assistantCount += 1;
	}
	return {
		transcript: lines.length > 0 ? lines.join("\n") : "No conversation yet.",
		userCount,
		assistantCount,
	};
}

export type HarassmentLabel = "normal" | "nonsense";

// Deliberate fail-OPEN default: a classifier outage (timeout, upstream error) must not
// itself block a student from continuing their case -- the cost of under-flagging one
// message during an outage is
// low, the cost of a wave of "please resend" errors for every student mid-simulation is not.
// Kept on its own small, unbiased classifier call (Haiku, no persona framing) rather than
// folded into the persona's own reply generation like referral/file-share eligibility now is
// (services/turn.ts) -- a model mid-roleplay as an in-character persona is a worse judge of
// whether the user just crossed a safety line than a clean, dedicated classifier prompt is.
// Do NOT "fix" this asymmetry -- it's intentional.
export async function classifyHarassment(
	userMessage: string,
	conversation: ChatMessage[],
): Promise<HarassmentLabel> {
	const { transcript } = formatTranscript(conversation);
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
			maxTokens: 10,
			timeoutMs: LLM_ATTEMPT_TIMEOUT_MS,
		});
	} catch {
		return "normal";
	}
	return raw.trim().toUpperCase().startsWith("NONSENSE")
		? "nonsense"
		: "normal";
}
