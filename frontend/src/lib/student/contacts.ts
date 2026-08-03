// Data-shaping helpers for the student chat view
import type { Api } from "../types.js";

export const normalizeMessages = (
	messages: Api<"ChatMessage">[] = [],
): Api<"ChatMessage">[] =>
	(messages ?? []).filter(
		(message) =>
			(message.role === "user" || message.role === "assistant") &&
			typeof message.content === "string",
	);

export const normalizeHistories = (
	histories: Record<string, Api<"ChatMessage">[]> = {},
): Record<string, Api<"ChatMessage">[]> =>
	Object.fromEntries(
		Object.entries(histories).map(([personaId, messages]) => [
			personaId,
			normalizeMessages(messages),
		]),
	);

export const getPersonaInitials = (name: string | undefined | null) =>
	name
		? name
				.split(" ")
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => part[0]?.toUpperCase() ?? "")
				.join("")
		: "NA";
