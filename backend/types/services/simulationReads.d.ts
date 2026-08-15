import type { FileEntryPayload, FileRefPayload } from "../models/cases";
export type PersonaDetail = {
    id: string;
    name: string;
    role: string;
    profilePhoto: FileRefPayload;
    profilePhotoUrl: string | null;
    availabilityDuration: number | null;
    knownFacts: string | null;
    personalityTraits: string | null;
    files: FileEntryPayload[];
    isReferred: boolean;
};
export type ReferralEdge = {
    parentPersonaId: string;
    referredPersonaId: string;
    conditionTrigger: string;
};
export type PersonaGraph = {
    personas: Map<string, PersonaDetail>;
    referrals: ReferralEdge[];
    roots: string[];
};
export declare function flattenPersonas(structure: unknown): PersonaGraph;
export declare function graphReferrals(graph: PersonaGraph, parentPersonaId: string): ReferralEdge[];
export declare function graphPersonas(graph: PersonaGraph, referredIds: Iterable<string>): PersonaDetail[];
export declare function graphPersonaById(graph: PersonaGraph, personaId: string): PersonaDetail | undefined;
export declare function graphRootPersonas(graph: PersonaGraph): PersonaDetail[];
