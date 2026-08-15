// Mirrors backend/infra/llm.py, using raw fetch against OpenRouter's OpenAI-compatible API
// instead of the `openai` SDK -- Phase 0's spike flagged the SDK's Convex-runtime story
// (default V8 isolate vs. "use node") as an open question; fetch sidesteps it entirely (no
// "use node" needed, works in the default runtime, no Node cold start) and drops a
// dependency, exactly the fallback the migration plan called for.

const LLM_BASE_URL = "https://openrouter.ai/api/v1";
const LLM_MODEL = "anthropic/claude-sonnet-5";
const LLM_CLASSIFIER_MODEL = "anthropic/claude-haiku-4.5";

// Mirrors backend/infra/settings.py's LLM timeout budget -- see its own comment for how
// these relate (LLM_ATTEMPT_TIMEOUT * PERSONA_REPLY_RETRIES is the worst case before
// personaReplyStream gives up).
const LLM_ATTEMPT_TIMEOUT_MS = 30_000;
const PERSONA_REPLY_RETRIES = 2;

function requireLlmKey(): string {
	const key = process.env.LLM_KEY;
	if (!key) throw new Error("Missing required environment variable: LLM_KEY");
	return key;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

// Mirrors backend/infra/llm.py's chat(). Its only caller is classifyHarassment, a
// temperature=0 classification gate -- pin routing to Anthropic directly so identical inputs
// aren't put through whatever upstream OpenRouter happens to pick for a given request.
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

	const response = await fetchWithTimeout(
		`${LLM_BASE_URL}/chat/completions`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${requireLlmKey()}` },
			body: JSON.stringify(body),
		},
		options.timeoutMs,
	);
	if (!response.ok) throw new Error(`LLM request failed (HTTP ${response.status}).`);
	const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
	return data.choices?.[0]?.message?.content ?? "";
}

// Schema the persona reply is constrained to (structured outputs). reply/introduce/
// send_files are generated as ONE schema-constrained JSON object -- the provider's
// constrained decoding guarantees introduce/send_files are always present and consistent
// with the same generation that produced reply, unlike an optional, separately-decided tool
// call the model can simply skip or contradict. Mirrors backend/infra/llm.py's
// PERSONA_REPLY_SCHEMA -- descriptions here are deliberately terse field labels, not the
// full contract (lib/prompt.ts's replyInstructions() already states that in the prompt).
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
// accumulates the full text and authoritatively parses it once the stream ends, same as the
// old backend. Mirrors backend/infra/llm.py's personaReplyStream, including its retry
// policy: retries a fresh attempt (never resumes a partial one) up to PERSONA_REPLY_RETRIES
// times, but only if nothing has streamed yet and the failure looks transient (connection
// reset, timeout, 429, 5xx) -- once any text has streamed, silently restarting would risk
// duplicating/losing content, so the error is raised instead.
export async function* personaReplyStream(messages: ChatMessage[]): AsyncGenerator<StreamDelta> {
	const body = {
		model: LLM_MODEL,
		messages,
		max_tokens: 600,
		stream: true,
		response_format: { type: "json_schema", json_schema: { name: "persona_reply", strict: true, schema: PERSONA_REPLY_SCHEMA } },
		provider: { order: ["anthropic"], allow_fallbacks: false },
	};

	for (let attempt = 1; attempt <= PERSONA_REPLY_RETRIES; attempt++) {
		const canRetry = attempt < PERSONA_REPLY_RETRIES;
		let response: Response;
		try {
			response = await fetchWithTimeout(
				`${LLM_BASE_URL}/chat/completions`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${requireLlmKey()}` },
					body: JSON.stringify(body),
				},
				LLM_ATTEMPT_TIMEOUT_MS,
			);
		} catch (err) {
			if (canRetry) continue;
			throw err;
		}
		if (!response.ok || !response.body) {
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
// Mirrors backend/infra/llm.py's formatTranscript.
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
	return { transcript: lines.length > 0 ? lines.join("\n") : "No conversation yet.", userCount, assistantCount };
}

export type HarassmentLabel = "normal" | "nonsense";

// Mirrors backend/infra/llm.py's classifyHarassment, including its deliberate fail-OPEN
// default: a classifier outage (timeout, upstream error) must not itself block a student
// from continuing their case -- the cost of under-flagging one message during an outage is
// low, the cost of a wave of "please resend" errors for every student mid-simulation is not.
// Kept on its own small, unbiased classifier call (Haiku, no persona framing) rather than
// folded into the persona's own reply generation like referral/file-share eligibility now is
// (services/turn.ts) -- a model mid-roleplay as an in-character persona is a worse judge of
// whether the user just crossed a safety line than a clean, dedicated classifier prompt is.
// Do NOT "fix" this asymmetry -- it's intentional.
export async function classifyHarassment(userMessage: string, conversation: ChatMessage[]): Promise<HarassmentLabel> {
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
	return raw.trim().toUpperCase().startsWith("NONSENSE") ? "nonsense" : "normal";
}
