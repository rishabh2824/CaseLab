import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { PersonaPayload, ReferralEdgePayload } from "../models/cases";
export declare function requireCaseAccess(ctx: QueryCtx | MutationCtx, c: Doc<"cases">, admin: Doc<"admins">): Promise<void>;
export declare function listCases(ctx: QueryCtx, admin: Doc<"admins">): Promise<Doc<"cases">[]>;
export declare function deleteCase(ctx: MutationCtx, caseId: Id<"cases">, admin: Doc<"admins">): Promise<void>;
export declare function validateGraph(personas: PersonaPayload[], referrals: ReferralEdgePayload[], roots: string[]): void;
export declare function buildStructure(ctx: MutationCtx, personas: PersonaPayload[], referrals: ReferralEdgePayload[], roots: string[]): Promise<{
    structure: unknown;
    fileIds: Set<Id<"files">>;
}>;
export type CasePayload = {
    name: string;
    brief: string;
    commonInformation?: string;
    duration?: number;
    accessCode?: string;
    personas: PersonaPayload[];
    referrals: ReferralEdgePayload[];
    roots: string[];
    collaboratorAdminIds: Id<"admins">[];
};
export declare function createCase(ctx: MutationCtx, payload: CasePayload, admin: Doc<"admins">): Promise<Id<"cases">>;
export declare function updateCase(ctx: MutationCtx, caseId: Id<"cases">, payload: CasePayload, admin: Doc<"admins">): Promise<void>;
