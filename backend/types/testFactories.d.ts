import type { FileEntryPayload, PersonaPayload, ReferralEdgePayload } from "./models/cases";
export declare function personaPayload(id: string, overrides?: Partial<PersonaPayload>): PersonaPayload;
export declare function referralEdge(from_id: string, to_id: string, conditions?: string | null): ReferralEdgePayload;
export declare function fileEntry(overrides?: Partial<{
    file_id: string | null;
    object_key: string;
    file_name: string;
    content_type: string | null;
    share_conditions: string | null;
    perceived_contents: string | null;
}>): FileEntryPayload;
export declare function caseStructure(overrides?: Partial<{
    personas: PersonaPayload[];
    referrals: ReferralEdgePayload[];
    roots: string[];
}>): {
    personas: {
        availability_minutes?: number | null | undefined;
        files?: {
            file?: {
                content_type?: string | null | undefined;
                file_id?: string | null | undefined;
                file_name: string;
                object_key: string;
            } | null | undefined;
            perceived_contents?: string | null | undefined;
            share_conditions?: string | null | undefined;
        }[] | undefined;
        id: string;
        known_facts?: string | null | undefined;
        name: string;
        personality_traits?: string | null | undefined;
        profile_photo?: {
            content_type?: string | null | undefined;
            file_id?: string | null | undefined;
            file_name: string;
            object_key: string;
        } | null | undefined;
        role: string;
    }[];
    referrals: {
        conditions?: string | null | undefined;
        from_id: string;
        to_id: string;
    }[];
    roots: string[];
};
