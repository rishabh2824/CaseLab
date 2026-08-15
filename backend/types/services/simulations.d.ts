import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
export type PersonaPhotoOut = {
    file_id: string | null;
    object_key: string;
    file_name: string;
    content_type: string | null;
    url: string;
};
export type ContactOut = {
    id: string;
    name: string;
    role: string;
    profile_photo: PersonaPhotoOut | null;
    availability_duration: number | null;
    available_at: number;
    is_referred: boolean;
    chat_ended: boolean;
    chat_end_reason: string | null;
    warning_count: number;
};
export type SharedFileOut = {
    file_id: string;
    file_name: string;
    content_type: string | null;
    url: string;
};
export type ChatMessageOut = {
    role: "user" | "assistant";
    content: string;
};
export type RunStateOut = {
    run_id: Id<"runs">;
    case: {
        id: Id<"cases">;
        case_name: string;
        brief: string;
        simulation_duration: number | null;
    };
    contacts: ContactOut[];
    active_persona_id: string;
    shared_files: SharedFileOut[];
};
export declare function startSimulation(ctx: MutationCtx, accessCodeRaw: string): Promise<RunStateOut>;
export declare function loadLiveRun(ctx: QueryCtx, runId: Id<"runs">): Promise<{
    run: Doc<"runs">;
    c: Doc<"cases">;
}>;
export declare function getSimulationState(ctx: QueryCtx, runId: Id<"runs">): Promise<RunStateOut>;
export declare function getPersonaHistory(ctx: QueryCtx, runId: Id<"runs">, personaId: string): Promise<ChatMessageOut[]>;
export type ExportPersonaOut = {
    id: string;
    name: string;
    role: string;
    messages: ChatMessageOut[];
};
export type ExportSimulationOut = {
    case: {
        id: Id<"cases">;
        case_name: string;
    };
    personas: ExportPersonaOut[];
};
export declare function exportSimulation(ctx: QueryCtx, runId: Id<"runs">): Promise<ExportSimulationOut>;
export declare function deleteRunCascade(ctx: MutationCtx, runId: Id<"runs">): Promise<void>;
export declare function deleteExpiredRuns(ctx: MutationCtx): Promise<number>;
