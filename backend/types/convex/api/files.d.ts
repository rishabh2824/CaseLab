export declare const resolveFileRefs: import("convex/server").RegisteredMutation<"public", {
    fileRefs: ({
        contentType?: string | undefined;
        fileName: string;
        objectKey: string;
    } | null)[];
}, Promise<(import("../services/files").ResolvedFileRef | null)[]>>;
export declare const getFileIfOrphaned: import("convex/server").RegisteredQuery<"internal", {
    fileId: import("convex/values").GenericId<"files">;
}, Promise<{
    _creationTime: number;
    _id: import("convex/values").GenericId<"files">;
    contentType?: string | undefined;
    name: string;
    objectKey: string;
} | null>>;
export declare const deleteFileRowIfOrphaned: import("convex/server").RegisteredMutation<"internal", {
    fileId: import("convex/values").GenericId<"files">;
}, Promise<void>>;
export declare const cleanupOrphanedFile: import("convex/server").RegisteredAction<"internal", {
    fileId: import("convex/values").GenericId<"files">;
}, Promise<void>>;
