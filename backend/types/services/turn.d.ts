import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { type ChatStateOut } from "../lib/turnState";
import { type PersonaDetail } from "./simulationReads";
export declare function startTurn(ctx: MutationCtx, runId: Id<"runs">, personaId: string, rawMessage: string): Promise<void>;
type PendingReferral = {
    referredPersonaId: string;
    conditionTrigger: string;
    referredName: string;
    referredRole: string;
};
type PendingFile = {
    fileId: string;
    fileName: string;
    contentType: string | null;
    objectKey: string;
    shareConditions: string | null;
    perceivedContents: string | null;
};
type DecisionMessage = {
    role: "user" | "assistant";
    content: string;
};
export type TurnContext = {
    caseBrief: string;
    commonInformation: string | null;
    persona: PersonaDetail;
    pendingReferrals: PendingReferral[];
    pendingFiles: PendingFile[];
    decisionHistory: DecisionMessage[];
};
export declare function getTurnContext(ctx: QueryCtx, runId: Id<"runs">, personaId: string): Promise<TurnContext>;
export declare function applyBoundary(ctx: MutationCtx, runId: Id<"runs">, personaId: string, label: string, personaName: string, streamId: Id<"streamingReplies">): Promise<ChatStateOut>;
export type UnlockedReferral = {
    referredPersonaId: string;
};
export type SharedFileInput = {
    fileId: Id<"files">;
    fileName: string;
    contentType: string | null;
    objectKey: string;
};
export declare function applyDecisions(ctx: MutationCtx, runId: Id<"runs">, personaId: string, reply: string, unlockedReferrals: UnlockedReferral[], sharedFiles: SharedFileInput[], streamId: Id<"streamingReplies">): Promise<void>;
export declare function writeStreamingPreview(ctx: MutationCtx, streamId: Id<"streamingReplies">, text: string): Promise<void>;
export type StreamingPreviewOut = {
    text: string;
    status: "streaming" | "done" | "error";
} | null;
export declare function markStreamingError(ctx: MutationCtx, streamId: Id<"streamingReplies">): Promise<void>;
export declare function getStreamingPreview(ctx: QueryCtx, runId: Id<"runs">, personaId: string): Promise<StreamingPreviewOut>;
export declare function runTurn(ctx: ActionCtx, runId: Id<"runs">, personaId: string, message: string, streamId: Id<"streamingReplies">): Promise<void>;
export {};
