// Pure data-shaping helpers
import type { ChatMessage, Contact } from "../types.js";

// Lowercase, replace runs of non-alphanumerics with a single '-', trim '-'.
export const slugify = (value: unknown) =>
	String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

export const countWords = (value: unknown) =>
	String(value ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;

export const normalizeMessages = (
	messages: ChatMessage[] = [],
): ChatMessage[] =>
	(messages ?? []).filter(
		(message) =>
			(message.role === "user" || message.role === "assistant") &&
			typeof message.content === "string",
	);

export const normalizeHistories = (
	histories: Record<string, ChatMessage[]> = {},
): Record<string, ChatMessage[]> =>
	Object.fromEntries(
		Object.entries(histories).map(([personaId, messages]) => [
			personaId,
			normalizeMessages(messages),
		]),
	);

const getPersonaInitials = (name: string | undefined | null) =>
	name
		? name
				.split(" ")
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => part[0]?.toUpperCase() ?? "")
				.join("")
		: "NA";

export type MappedContact = {
	id: string;
	initials: string;
	name: string;
	title: string;
	profilePhotoUrl: string | null;
	availability: number | null | undefined;
	isReferred: boolean;
	available: boolean;
	availableIn: number | null;
	expiresIn: number | null;
	chatEnded: boolean;
	chatEndReason: string | null;
	warningCount: number;
};

export const mapContact = (persona: Contact): MappedContact => {
	const availability = persona.availability_duration;
	return {
		id: persona.id,
		initials: getPersonaInitials(persona.name),
		name: persona.name || "Unnamed",
		title: persona.role || "Role",
		profilePhotoUrl: persona.profile_photo?.url || null,
		availability,
		isReferred: persona.is_referred ?? false,
		available: persona.available ?? false,
		availableIn: persona.available_in ?? null,
		expiresIn: persona.expires_in ?? null,
		chatEnded: persona.chat_ended ?? false,
		chatEndReason: persona.chat_end_reason ?? null,
		warningCount: persona.warning_count ?? 0,
	};
};
