import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
export declare function guardNoLiveRuns(ctx: QueryCtx, caseId: Id<"cases">): Promise<void>;
