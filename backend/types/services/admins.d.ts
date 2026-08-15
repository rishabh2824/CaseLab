import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { AdminRole } from "../models/admin";
export declare function getAdminByEmail(ctx: QueryCtx | MutationCtx, email: string): Promise<{
    _creationTime: number;
    _id: import("convex/values").GenericId<"admins">;
    email: string;
    name?: string | undefined;
    role: "admin" | "super";
} | null>;
export declare function requireCurrentAdmin(ctx: QueryCtx | MutationCtx): Promise<Doc<"admins">>;
export declare function requireSuperAdmin(ctx: QueryCtx | MutationCtx): Promise<Doc<"admins">>;
export declare function listAdmins(ctx: QueryCtx): Promise<Doc<"admins">[]>;
export declare function createAdmin(ctx: MutationCtx, args: {
    email: string;
    name?: string;
    role: AdminRole;
}): Promise<Doc<"admins">>;
export declare function deleteAdminWithCascade(ctx: MutationCtx, adminId: Id<"admins">): Promise<{
    ok: true;
    casesDeleted: number;
    casesReassigned: number;
}>;
