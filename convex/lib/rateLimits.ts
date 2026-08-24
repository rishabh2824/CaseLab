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
	// Sharded, unlike message above: message is keyed by runId, one student's own turn-taking,
	// so there's no cross-student contention to shard away. simulationStart is keyed by access
	// code (see simulationLimit below) -- every student in a case shares that one key, so an
	// instructor's "everyone start now" sends dozens of concurrent mutations at the same
	// underlying row. The component defaults to shards: 1 (a single row per key) when unset;
	// splitting into 10 spreads that write contention across 10 rows instead of serializing the
	// whole class behind one, at the cost of the bucket's capacity/refill being approximate
	// (spread across shards) rather than exact -- an acceptable tradeoff for a limit whose job
	// is "stop abuse," not enforce a precise global count.
	simulationStart: {
		kind: "token bucket",
		rate: 200,
		period: MINUTE,
		shards: 10,
	},
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
