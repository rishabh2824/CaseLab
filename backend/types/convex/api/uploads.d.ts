type PresignResult = {
    uploadUrl: string;
    objectKey: string;
    fileName: string;
    contentType: string | undefined;
    expiresIn: number;
};
export declare const presignUpload: import("convex/server").RegisteredAction<"public", {
    contentType?: string | undefined;
    fileName: string;
    prefix?: string | undefined;
}, Promise<PresignResult>>;
export declare const presignUploadBatch: import("convex/server").RegisteredAction<"public", {
    files: {
        contentType?: string | undefined;
        fileName: string;
        prefix?: string | undefined;
    }[];
}, Promise<PresignResult[]>>;
export {};
