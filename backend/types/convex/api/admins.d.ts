export declare const viewer: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    email: string;
    name: string | undefined;
    role: "admin" | "super";
} | null>>;
export declare const listAll: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    _creationTime: number;
    _id: import("convex/values").GenericId<"admins">;
    email: string;
    name?: string | undefined;
    role: "admin" | "super";
}[]>>;
export declare const create: import("convex/server").RegisteredMutation<"public", {
    email: string;
    name?: string | undefined;
    role: "admin" | "super";
}, Promise<{
    _creationTime: number;
    _id: import("convex/values").GenericId<"admins">;
    email: string;
    name?: string | undefined;
    role: "admin" | "super";
}>>;
export declare const deleteWithCascade: import("convex/server").RegisteredMutation<"public", {
    adminId: import("convex/values").GenericId<"admins">;
}, Promise<{
    ok: true;
    casesDeleted: number;
    casesReassigned: number;
}>>;
export declare const requireCurrentAdminInternal: import("convex/server").RegisteredQuery<"internal", {}, Promise<void>>;
