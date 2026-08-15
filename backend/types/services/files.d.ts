import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
export type FileRefInput = {
    objectKey: string;
    fileName: string;
    contentType?: string;
};
export type ResolvedFileRef = {
    fileId: Id<"files">;
    objectKey: string;
    fileName: string;
    contentType: string | undefined;
};
export declare function resolveFileRefs(ctx: MutationCtx, fileRefs: (FileRefInput | null)[]): Promise<(ResolvedFileRef | null)[]>;
export declare function fileHasReferences(ctx: QueryCtx | MutationCtx, fileId: Id<"files">): Promise<boolean>;
export declare function syncCaseFiles(ctx: MutationCtx, caseId: Id<"cases">, desiredFileIds: Set<Id<"files">>): Promise<void>;
