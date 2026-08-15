export declare function presignPutUrl(objectKey: string, contentType: string | undefined, expiresInSeconds: number): Promise<string>;
export declare function presignGetUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
export declare function deleteObject(objectKey: string): Promise<void>;
