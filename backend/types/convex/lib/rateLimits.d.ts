import type { MutationCtx } from "../_generated/server";
export declare function messageLimit(ctx: MutationCtx, runId: string): Promise<void>;
export declare function simulationLimit(ctx: MutationCtx, accessCode: string): Promise<void>;
