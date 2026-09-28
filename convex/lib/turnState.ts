// Returns the whole minutes elapsed between two timestamps.
export function elapsedMinutes(startTime: number, now: number): number {
	return Math.floor((now - startTime) / 60_000);
}

export type Availability = {
	available: boolean;
	availableIn: number | null;
	expiresIn: number | null;
};

// Computes whether a persona is available at the elapsed time, and how long until it is or expires.
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

export type ChatStateMap = Record<
	string,
	{ warningCount: number; ended: boolean; endReason?: string }
>;
export type ChatStateOut = {
	ended: boolean;
	endReason: string | null;
	warningCount: number;
};

// Returns a persona's chat state, defaulting to an open chat with no warnings.
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

export const NONSENSE_THRESHOLD = 3;

// Returns the canned warning or chat-ending message for a flagged message.
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
