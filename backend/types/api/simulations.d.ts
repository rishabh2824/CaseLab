export declare const start: import("convex/server").RegisteredMutation<"public", {
    accessCode: string;
}, Promise<import("../services/simulations").RunStateOut>>;
export declare const get: import("convex/server").RegisteredQuery<"public", {
    runId: import("convex/values").GenericId<"runs">;
}, Promise<import("../services/simulations").RunStateOut>>;
export declare const getPersonaHistory: import("convex/server").RegisteredQuery<"public", {
    personaId: string;
    runId: import("convex/values").GenericId<"runs">;
}, Promise<import("../services/simulations").ChatMessageOut[]>>;
export declare const exportRun: import("convex/server").RegisteredQuery<"public", {
    runId: import("convex/values").GenericId<"runs">;
}, Promise<import("../services/simulations").ExportSimulationOut>>;
export declare const destroy: import("convex/server").RegisteredMutation<"internal", {
    runId: import("convex/values").GenericId<"runs">;
}, Promise<void>>;
export declare const deleteExpiredRuns: import("convex/server").RegisteredMutation<"internal", {}, Promise<number>>;
