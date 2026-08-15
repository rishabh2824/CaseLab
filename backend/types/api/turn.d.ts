export declare const start: import("convex/server").RegisteredMutation<"public", {
    message: string;
    personaId: string;
    runId: import("convex/values").GenericId<"runs">;
}, Promise<void>>;
export declare const getTurnContext: import("convex/server").RegisteredQuery<"internal", {
    personaId: string;
    runId: import("convex/values").GenericId<"runs">;
}, Promise<import("../services/turn").TurnContext>>;
export declare const runTurn: import("convex/server").RegisteredAction<"internal", {
    message: string;
    personaId: string;
    runId: import("convex/values").GenericId<"runs">;
    streamId: import("convex/values").GenericId<"streamingReplies">;
}, Promise<void>>;
export declare const writeStreamingPreview: import("convex/server").RegisteredMutation<"internal", {
    streamId: import("convex/values").GenericId<"streamingReplies">;
    text: string;
}, Promise<void>>;
export declare const getStreamingPreview: import("convex/server").RegisteredQuery<"public", {
    personaId: string;
    runId: import("convex/values").GenericId<"runs">;
}, Promise<import("../services/turn").StreamingPreviewOut>>;
export declare const applyBoundary: import("convex/server").RegisteredMutation<"internal", {
    label: string;
    personaId: string;
    personaName: string;
    runId: import("convex/values").GenericId<"runs">;
    streamId: import("convex/values").GenericId<"streamingReplies">;
}, Promise<import("../lib/turnState").ChatStateOut>>;
export declare const markStreamingError: import("convex/server").RegisteredMutation<"internal", {
    streamId: import("convex/values").GenericId<"streamingReplies">;
}, Promise<void>>;
export declare const applyDecisions: import("convex/server").RegisteredMutation<"internal", {
    personaId: string;
    reply: string;
    runId: import("convex/values").GenericId<"runs">;
    sharedFiles: {
        contentType: string | null;
        fileId: import("convex/values").GenericId<"files">;
        fileName: string;
        objectKey: string;
    }[];
    streamId: import("convex/values").GenericId<"streamingReplies">;
    unlockedReferrals: {
        referredPersonaId: string;
    }[];
}, Promise<void>>;
