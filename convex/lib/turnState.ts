// Mirrors backend/services/simulation/turn_state.py's elapsedMinutes.
export function elapsedMinutes(startTime: number, now: number): number {
	return Math.floor((now - startTime) / 60_000);
}

export type Availability = {
	available: boolean;
	availableIn: number | null;
	expiresIn: number | null;
};

// Mirrors backend/services/simulation/turn_state.py's personaAvailability: computes whether
// a persona should currently be reachable.
export function personaAvailability(
	availabilityDuration: number | null,
	availableAtMinutes: number,
	elapsed: number,
): Availability {
	if (elapsed < availableAtMinutes) {
		return {
			available: false,
			availableIn: availableAtMinutes - elapsed,
			expiresIn: null,
		};
	}
	if (availabilityDuration !== null) {
		const expiresAt = availableAtMinutes + availabilityDuration;
		if (elapsed > expiresAt)
			return { available: false, availableIn: null, expiresIn: 0 };
		return {
			available: true,
			availableIn: 0,
			expiresIn: Math.max(0, expiresAt - elapsed),
		};
	}
	return { available: true, availableIn: 0, expiresIn: null };
}

// Mirrors schema.ts's chatState validator (itself a mirror of backend/models/runtime.py's
// ChatState) -- kept here, not imported from schema.ts, since these are plain data shapes
// with no Convex validator machinery attached.
export type ChatStateMap = Record<
	string,
	{ warningCount: number; ended: boolean; endReason?: string }
>;
export type ChatStateOut = {
	ended: boolean;
	endReason: string | null;
	warningCount: number;
};

// Mirrors backend/services/simulation/turn_state.py's getChatState. Takes the map directly
// (not a full run doc) so it works both against a real run's `personaChatState` and against
// a plain `{}` at the moment startSimulation is still deciding a run's initial contacts,
// before any run document exists to read one from.
export function getChatState(
	personaChatState: ChatStateMap,
	personaId: string,
): ChatStateOut {
	const state = personaChatState[personaId];
	return state
		? {
				ended: state.ended,
				endReason: state.endReason ?? null,
				warningCount: state.warningCount,
			}
		: { ended: false, endReason: null, warningCount: 0 };
}

// backend/services/simulation/turn_state.py's editChatState/shapeChatState/chatStatePayload
// aren't ported as separate functions: editChatState's only "pure" content is the same
// get-with-default logic getChatState above already provides -- the rest of it (returning a
// mutable reference into `run.persona_chat_state` for the caller to edit in place) doesn't
// have an equivalent in Convex's immutable-update model, where services/turn.ts's
// applyBoundary instead computes a new ChatState value and `ctx.db.patch`es it. Likewise,
// shapeChatState/chatStatePayload's trimmed shape is exactly ChatStateOut above.

// Number of nonsense messages allowed before ending the chat.
export const NONSENSE_THRESHOLD = 3;

// Mirrors backend/services/simulation/turn_state.py's boundaryReply: a persona's canned
// response to a harassment/nonsense-classified message.
export function boundaryReply(personaName: string, shouldEnd: boolean): string {
	const name = personaName || "I";
	if (shouldEnd) {
		return (
			`${name} is ending this conversation because the messages are not coherent or ` +
			"respectful enough to continue. Please send clear, respectful case-related " +
			"questions to another contact."
		);
	}
	return (
		"I am not able to follow that. Please send a clear, respectful, case-related " +
		"question if you want to continue."
	);
}
