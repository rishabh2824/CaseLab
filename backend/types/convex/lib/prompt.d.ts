import type { PersonaDetail } from "../services/simulationReads";
export type CandidateReferral = {
    handle: string;
    name: string;
    role: string;
    conditionTrigger: string;
};
export type CandidateFile = {
    handle: string;
    name: string;
    perceivedContents: string | null;
    shareConditions: string | null;
};
export declare function systemPrompt(caseBrief: string, commonInformation: string | null, persona: PersonaDetail, candidateReferrals: CandidateReferral[], candidateFiles: CandidateFile[]): string;
export declare function replyInstructions(): string;
export declare function cleanReply(text: string | null | undefined): string;
export declare function parseReply(raw: string | null | undefined): Record<string, unknown> | null;
export declare function coerceHandles(value: unknown): string[];
