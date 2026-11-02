// Returns the whole minutes elapsed between two timestamps, never negative.
export function elapsedMinutes(startTime: number, now: number): number {
	return Math.max(0, Math.floor((now - startTime) / 60_000));
}

export type Availability = {
	available: boolean;
	expiresIn: number | null;
};

// Computes whether a persona is still available at the elapsed time, and how long until it expires. Personas only exist once unlocked, so the only way to become unavailable is to expire.
export function personaAvailability(
	availabilityDuration: number | null,
	availableAtMinutes: number,
	elapsed: number,
): Availability {
	if (availabilityDuration === null)
		return { available: true, expiresIn: null };
	const expiresAt = availableAtMinutes + availabilityDuration;
	if (elapsed > expiresAt) return { available: false, expiresIn: 0 };
	return { available: true, expiresIn: expiresAt - elapsed };
}
