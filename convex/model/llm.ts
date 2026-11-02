import { env } from "../_generated/server";

const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
const LLM_MODEL = "anthropic/claude-sonnet-5.5";
const LLM_CLASSIFIER_MODEL = "anthropic/claude-haiku-5.5";

export const LLM_ATTEMPT_TIMEOUT_MS = 10_000;
const CLASSIFIER_TIMEOUT_MS = 6_000;
export const PERSONA_REPLY_RETRIES = 2;

export type TranscriptMessage = {
	role: "user" | "assistant";
	content: string;
};

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

// POSTs a non-streaming chat-completions request to the LLM provider and returns the first choice's text. Throws on a transport error, timeout, non-2xx status or empty body.
async function chatCompletion(
	body: Record<string, unknown>,
	timeoutMs: number,
) {
	const baseUrl = env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL;
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${env.LLM_KEY}`,
		},
		body: JSON.stringify({
			...body,
			provider: { order: ["anthropic"], allow_fallbacks: false },
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok)
		throw new Error(`LLM request failed (HTTP ${response.status}).`);
	const data = (await response.json()) as {
		choices?: { message?: { content?: string }; finish_reason?: string }[];
	};
	const content = data.choices?.[0]?.message?.content;
	if (!content)
		throw new Error(
			`LLM returned no content (finish_reason: ${data.choices?.[0]?.finish_reason}).`,
		);
	return content;
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

export type PersonaReply = {
	reply: string;
	introduce: string[];
	sendFiles: string[];
};

// Generates a persona's reply as strict JSON, retrying a failed or truncated attempt.
export async function generatePersonaReply(
	systemPrompt: { cacheable: string; dynamic: string },
	history: ChatMessage[],
): Promise<PersonaReply> {
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
		response_format: {
			type: "json_schema",
			json_schema: {
				name: "persona_reply",
				strict: true,
				schema: PERSONA_REPLY_SCHEMA,
			},
		},
		reasoning: { effort: "low" },
	};

	for (let attempt = 1; ; attempt++) {
		try {
			// The schema is enforced by the provider, so a parse failure means a truncated or faulty response.
			return JSON.parse(
				await chatCompletion(body, LLM_ATTEMPT_TIMEOUT_MS),
			) as PersonaReply;
		} catch (err) {
			if (attempt >= PERSONA_REPLY_RETRIES) throw err;
		}
	}
}

// How many recent turns (a student message and its reply) reach the model.
export const RECENT_HISTORY_LIMIT = 5;

// Formats the conversation, already limited to the recent turns, as 'role: content' lines.
function formatTranscript(conversation: TranscriptMessage[]): string {
	const lines = conversation.map(
		(message) => `${message.role}: ${message.content}`,
	);
	return lines.length > 0 ? lines.join("\n") : "No conversation yet.";
}

export type MessageLabel = "ok" | "flagged";

const CLASSIFIER_SCHEMA = {
	type: "object",
	properties: { label: { type: "string", enum: ["ok", "flagged"] } },
	required: ["label"],
	additionalProperties: false,
};

// Classifies the latest student message as ok or flagged (spam, gibberish or abuse), defaulting to ok if the call fails.
export async function classifyMessage(
	userMessage: string,
	conversation: TranscriptMessage[],
): Promise<MessageLabel> {
	const transcript = formatTranscript(conversation);
	const systemPrompt =
		"You are a strict conversation safety classifier for a case simulation. " +
		"Classify the latest user message in context as ok or flagged.\n" +
		"Use flagged for spam, gibberish, or repeatedly incoherent case-irrelevant " +
		"input, AND for rude, insulting, harassing, or abusive messages, including " +
		"explicit threats or severe abuse — anything that isn't a normal, coherent, " +
		"case-related message.\n" +
		"Otherwise use ok.";
	const userPrompt = `Recent conversation:\n${transcript}\n\nLatest user message:\n${userMessage}`;

	try {
		const raw = await chatCompletion(
			{
				model: LLM_CLASSIFIER_MODEL,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				temperature: 0,
				max_tokens: 50,
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "classification",
						strict: true,
						schema: CLASSIFIER_SCHEMA,
					},
				},
			},
			CLASSIFIER_TIMEOUT_MS,
		);
		// Anything but an explicit "flagged" counts as ok, so a malformed answer can never flag a student.
		return (JSON.parse(raw) as { label?: string }).label === "flagged"
			? "flagged"
			: "ok";
	} catch (err) {
		console.warn("Message classifier failed; treating the message as ok", err);
		return "ok";
	}
}
