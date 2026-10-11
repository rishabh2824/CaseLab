import http from "node:http";

// A stand-in for the LLM provider. The backend is pointed at it through LLM_BASE_URL, so no test-only
// path exists in the production code. The reply is chosen by keywords in the student's latest message.

type ChatBody = {
	messages: { role: string; content: unknown }[];
	response_format?: { json_schema?: { name?: string } };
};

// Returns the text of a message whose content is a string or a list of text blocks.
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (block as { text?: string }).text ?? "")
			.join("\n");
	}
	return "";
}

// Builds the persona's reply for a student message.
function personaReply(message: string) {
	if (/\bCOO\b/.test(message)) {
		return {
			reply: "Let me connect you with Bob.",
			introduce: ["R1"],
			sendFiles: [],
		};
	}
	return {
		reply: "Our vendor is Acme Supplies.",
		introduce: [],
		sendFiles: [],
	};
}

export const LLM_STUB_PORT = 4010;

// Starts the stub on a fixed local port and returns a function that stops it.
export function startLlmStub(): Promise<() => Promise<void>> {
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw || "{}") as ChatBody;
			const isReply =
				body.response_format?.json_schema?.name === "persona_reply";
			const lastUser = [...body.messages]
				.reverse()
				.find((message) => message.role === "user");
			const content = isReply
				? personaReply(textOf(lastUser?.content))
				: { label: "normal" };
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					choices: [{ message: { content: JSON.stringify(content) } }],
				}),
			);
		});
	});
	return new Promise((resolve) => {
		server.listen(LLM_STUB_PORT, "127.0.0.1", () => {
			resolve(() => new Promise<void>((done) => server.close(() => done())));
		});
	});
}
