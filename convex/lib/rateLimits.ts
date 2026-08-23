import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";

// A token bucket, not a fixed-window counter: a fixed 60-second window lets a client send up
// to 2x its per-minute allowance by timing requests to straddle a window boundary (e.g. 15
// messages at 0:59, another 15 at 1:01, both within the same rolling minute). A token bucket
// replenishes continuously instead of resetting a full allowance at fixed instants, so no
// boundary-straddling burst is possible.
const rateLimiter = new RateLimiter(components.rateLimiter, {
	message: { kind: "token bucket", rate: 15, period: MINUTE },
	simulationStart: { kind: "token bucket", rate: 200, period: MINUTE },
});

// Called by services/turn.ts's startTurn.
export async function messageLimit(
	ctx: MutationCtx,
	runId: string,
): Promise<void> {
	const status = await rateLimiter.limit(ctx, "message", { key: runId });
	if (!status.ok) throw new Error("Rate limit exceeded.");
}

// Keyed by the same normalized (lowercased) access code used for the case lookup, not the
// raw student input -- otherwise casing alone would dodge the limit.
export async function simulationLimit(
	ctx: MutationCtx,
	accessCode: string,
): Promise<void> {
	const status = await rateLimiter.limit(ctx, "simulationStart", {
		key: accessCode,
	});
	if (!status.ok) {
		throw new Error(
			"Too many simulations have been started with this access code recently. Please wait a moment and try again.",
		);
	}
}
