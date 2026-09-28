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
