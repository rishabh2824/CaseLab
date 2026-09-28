import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { STUDENT_ERROR, studentError } from "./studentErrors";

const rateLimiter = new RateLimiter(components.rateLimiter, {
	message: { kind: "token bucket", rate: 15, period: MINUTE },
	simulationStart: {
		kind: "token bucket",
		rate: 200,
		period: MINUTE,
		shards: 10,
	},
});

// Enforces the per-run message rate limit, throwing a student error when exceeded.
export async function messageLimit(
	ctx: MutationCtx,
	runId: string,
): Promise<void> {
	const status = await rateLimiter.limit(ctx, "message", { key: runId });
	if (!status.ok)
		throw studentError(
			STUDENT_ERROR.MESSAGE_RATE_LIMITED,
			"Rate limit exceeded.",
		);
}

// Enforces the per-access-code simulation start rate limit, throwing a student error when exceeded.
export async function simulationLimit(
	ctx: MutationCtx,
	accessCode: string,
): Promise<void> {
	const status = await rateLimiter.limit(ctx, "simulationStart", {
		key: accessCode,
	});
	if (!status.ok) {
		throw studentError(
			STUDENT_ERROR.SIMULATION_RATE_LIMITED,
			"Too many simulations have been started with this access code recently. Please wait a moment and try again.",
		);
	}
}
