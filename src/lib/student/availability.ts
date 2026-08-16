// Mirrors backend/convex/lib/turnState.ts's Availability/personaAvailability --
// duplicated here (not imported cross-package, see ../types.ts's comment on why) because
// this needs to run client-side, ticking off a live clock. A Convex query only re-runs when
// its underlying DATA changes, never on elapsed wall-clock time alone, so the earlier design
// (baking available/available_in/expires_in into ContactOut server-side, computed against
// Date.now() inside the query) meant a persona's availability window silently never expired,
// and "available in N min" never ticked down, until some unrelated write happened to
// re-trigger the query. RunStore (run.svelte.ts) calls this against its own ticking clock
// instead, using the raw `available_at` minute the server now sends.
export type Availability = {
	available: boolean;
	availableIn: number | null;
	expiresIn: number | null;
};

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
