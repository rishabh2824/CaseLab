declare const _default: import("convex/server").SchemaDefinition<{
    users: import("convex/server").TableDefinition<import("convex/values").VObject<{
        name?: string | undefined;
        email?: string | undefined;
        phone?: string | undefined;
        image?: string | undefined;
        emailVerificationTime?: number | undefined;
        phoneVerificationTime?: number | undefined;
        isAnonymous?: boolean | undefined;
    }, {
        name: import("convex/values").VString<string | undefined, "optional">;
        image: import("convex/values").VString<string | undefined, "optional">;
        email: import("convex/values").VString<string | undefined, "optional">;
        emailVerificationTime: import("convex/values").VFloat64<number | undefined, "optional">;
        phone: import("convex/values").VString<string | undefined, "optional">;
        phoneVerificationTime: import("convex/values").VFloat64<number | undefined, "optional">;
        isAnonymous: import("convex/values").VBoolean<boolean | undefined, "optional">;
    }, "required", "name" | "email" | "phone" | "image" | "emailVerificationTime" | "phoneVerificationTime" | "isAnonymous">, {
        email: ["email", "_creationTime"];
        phone: ["phone", "_creationTime"];
    }, {}, {}>;
    authSessions: import("convex/server").TableDefinition<import("convex/values").VObject<{
        userId: import("convex/values").GenericId<"users">;
        expirationTime: number;
    }, {
        userId: import("convex/values").VId<import("convex/values").GenericId<"users">, "required">;
        expirationTime: import("convex/values").VFloat64<number, "required">;
    }, "required", "userId" | "expirationTime">, {
        userId: ["userId", "_creationTime"];
    }, {}, {}>;
    authAccounts: import("convex/server").TableDefinition<import("convex/values").VObject<{
        secret?: string | undefined;
        emailVerified?: string | undefined;
        phoneVerified?: string | undefined;
        userId: import("convex/values").GenericId<"users">;
        provider: string;
        providerAccountId: string;
    }, {
        userId: import("convex/values").VId<import("convex/values").GenericId<"users">, "required">;
        provider: import("convex/values").VString<string, "required">;
        providerAccountId: import("convex/values").VString<string, "required">;
        secret: import("convex/values").VString<string | undefined, "optional">;
        emailVerified: import("convex/values").VString<string | undefined, "optional">;
        phoneVerified: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "secret" | "userId" | "provider" | "providerAccountId" | "emailVerified" | "phoneVerified">, {
        userIdAndProvider: ["userId", "provider", "_creationTime"];
        providerAndAccountId: ["provider", "providerAccountId", "_creationTime"];
    }, {}, {}>;
    authRefreshTokens: import("convex/server").TableDefinition<import("convex/values").VObject<{
        firstUsedTime?: number | undefined;
        parentRefreshTokenId?: import("convex/values").GenericId<"authRefreshTokens"> | undefined;
        expirationTime: number;
        sessionId: import("convex/values").GenericId<"authSessions">;
    }, {
        sessionId: import("convex/values").VId<import("convex/values").GenericId<"authSessions">, "required">;
        expirationTime: import("convex/values").VFloat64<number, "required">;
        firstUsedTime: import("convex/values").VFloat64<number | undefined, "optional">;
        parentRefreshTokenId: import("convex/values").VId<import("convex/values").GenericId<"authRefreshTokens"> | undefined, "optional">;
    }, "required", "expirationTime" | "sessionId" | "firstUsedTime" | "parentRefreshTokenId">, {
        sessionId: ["sessionId", "_creationTime"];
        sessionIdAndParentRefreshTokenId: ["sessionId", "parentRefreshTokenId", "_creationTime"];
    }, {}, {}>;
    authVerificationCodes: import("convex/server").TableDefinition<import("convex/values").VObject<{
        emailVerified?: string | undefined;
        phoneVerified?: string | undefined;
        verifier?: string | undefined;
        expirationTime: number;
        provider: string;
        accountId: import("convex/values").GenericId<"authAccounts">;
        code: string;
    }, {
        accountId: import("convex/values").VId<import("convex/values").GenericId<"authAccounts">, "required">;
        provider: import("convex/values").VString<string, "required">;
        code: import("convex/values").VString<string, "required">;
        expirationTime: import("convex/values").VFloat64<number, "required">;
        verifier: import("convex/values").VString<string | undefined, "optional">;
        emailVerified: import("convex/values").VString<string | undefined, "optional">;
        phoneVerified: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "expirationTime" | "provider" | "emailVerified" | "phoneVerified" | "accountId" | "code" | "verifier">, {
        accountId: ["accountId", "_creationTime"];
        code: ["code", "_creationTime"];
    }, {}, {}>;
    authVerifiers: import("convex/server").TableDefinition<import("convex/values").VObject<{
        sessionId?: import("convex/values").GenericId<"authSessions"> | undefined;
        signature?: string | undefined;
    }, {
        sessionId: import("convex/values").VId<import("convex/values").GenericId<"authSessions"> | undefined, "optional">;
        signature: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "sessionId" | "signature">, {
        signature: ["signature", "_creationTime"];
    }, {}, {}>;
    authRateLimits: import("convex/server").TableDefinition<import("convex/values").VObject<{
        identifier: string;
        lastAttemptTime: number;
        attemptsLeft: number;
    }, {
        identifier: import("convex/values").VString<string, "required">;
        lastAttemptTime: import("convex/values").VFloat64<number, "required">;
        attemptsLeft: import("convex/values").VFloat64<number, "required">;
    }, "required", "identifier" | "lastAttemptTime" | "attemptsLeft">, {
        identifier: ["identifier", "_creationTime"];
    }, {}, {}>;
    admins: import("convex/server").TableDefinition<import("convex/values").VObject<{
        email: string;
        name?: string | undefined;
        role: "admin" | "super";
    }, {
        email: import("convex/values").VString<string, "required">;
        name: import("convex/values").VString<string | undefined, "optional">;
        role: import("convex/values").VUnion<"admin" | "super", [import("convex/values").VLiteral<"super", "required">, import("convex/values").VLiteral<"admin", "required">], "required", never>;
    }, "required", "email" | "name" | "role">, {
        by_email: ["email", "_creationTime"];
    }, {}, {}>;
    cases: import("convex/server").TableDefinition<import("convex/values").VObject<{
        accessCode?: string | undefined;
        brief: string;
        commonInformation?: string | undefined;
        duration?: number | undefined;
        name: string;
        ownerAdminId: import("convex/values").GenericId<"admins">;
        structure: any;
    }, {
        name: import("convex/values").VString<string, "required">;
        brief: import("convex/values").VString<string, "required">;
        commonInformation: import("convex/values").VString<string | undefined, "optional">;
        duration: import("convex/values").VFloat64<number | undefined, "optional">;
        accessCode: import("convex/values").VString<string | undefined, "optional">;
        ownerAdminId: import("convex/values").VId<import("convex/values").GenericId<"admins">, "required">;
        structure: import("convex/values").VAny<any, "required", string>;
    }, "required", "accessCode" | "brief" | "commonInformation" | "duration" | "name" | "ownerAdminId" | "structure" | `structure.${string}`>, {
        by_access_code: ["accessCode", "_creationTime"];
        by_owner: ["ownerAdminId", "_creationTime"];
    }, {}, {}>;
    collaborators: import("convex/server").TableDefinition<import("convex/values").VObject<{
        addedAt: number;
        adminId: import("convex/values").GenericId<"admins">;
        caseId: import("convex/values").GenericId<"cases">;
    }, {
        caseId: import("convex/values").VId<import("convex/values").GenericId<"cases">, "required">;
        adminId: import("convex/values").VId<import("convex/values").GenericId<"admins">, "required">;
        addedAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "addedAt" | "adminId" | "caseId">, {
        by_admin: ["adminId", "_creationTime"];
        by_case: ["caseId", "_creationTime"];
    }, {}, {}>;
    files: import("convex/server").TableDefinition<import("convex/values").VObject<{
        contentType?: string | undefined;
        name: string;
        objectKey: string;
    }, {
        objectKey: import("convex/values").VString<string, "required">;
        name: import("convex/values").VString<string, "required">;
        contentType: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "contentType" | "name" | "objectKey">, {
        by_object_key: ["objectKey", "_creationTime"];
    }, {}, {}>;
    caseFiles: import("convex/server").TableDefinition<import("convex/values").VObject<{
        caseId: import("convex/values").GenericId<"cases">;
        fileId: import("convex/values").GenericId<"files">;
    }, {
        caseId: import("convex/values").VId<import("convex/values").GenericId<"cases">, "required">;
        fileId: import("convex/values").VId<import("convex/values").GenericId<"files">, "required">;
    }, "required", "caseId" | "fileId">, {
        by_case: ["caseId", "_creationTime"];
        by_file: ["fileId", "_creationTime"];
    }, {}, {}>;
    runs: import("convex/server").TableDefinition<import("convex/values").VObject<{
        activePersonaKey: string;
        caseId: import("convex/values").GenericId<"cases">;
        destroyJobId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
        expiresAt: number;
        personaChatState: Record<string, {
            endReason?: string | undefined;
            ended: boolean;
            lastFlagType?: string | undefined;
            warningCount: number;
        }>;
        sharedFiles: Record<string, {
            contentType?: string | undefined;
            fileId: import("convex/values").GenericId<"files">;
            fileName: string;
            objectKey: string;
        }>;
        startTime: number;
        unlockedAt: Record<string, number>;
        unlockedReferredIds: string[];
    }, {
        caseId: import("convex/values").VId<import("convex/values").GenericId<"cases">, "required">;
        startTime: import("convex/values").VFloat64<number, "required">;
        expiresAt: import("convex/values").VFloat64<number, "required">;
        activePersonaKey: import("convex/values").VString<string, "required">;
        unlockedReferredIds: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
        unlockedAt: import("convex/values").VRecord<Record<string, number>, import("convex/values").VString<string, "required">, import("convex/values").VFloat64<number, "required">, "required", string>;
        sharedFiles: import("convex/values").VRecord<Record<string, {
            contentType?: string | undefined;
            fileId: import("convex/values").GenericId<"files">;
            fileName: string;
            objectKey: string;
        }>, import("convex/values").VString<string, "required">, import("convex/values").VObject<{
            contentType?: string | undefined;
            fileId: import("convex/values").GenericId<"files">;
            fileName: string;
            objectKey: string;
        }, {
            fileId: import("convex/values").VId<import("convex/values").GenericId<"files">, "required">;
            fileName: import("convex/values").VString<string, "required">;
            contentType: import("convex/values").VString<string | undefined, "optional">;
            objectKey: import("convex/values").VString<string, "required">;
        }, "required", "contentType" | "fileId" | "fileName" | "objectKey">, "required", string>;
        personaChatState: import("convex/values").VRecord<Record<string, {
            endReason?: string | undefined;
            ended: boolean;
            lastFlagType?: string | undefined;
            warningCount: number;
        }>, import("convex/values").VString<string, "required">, import("convex/values").VObject<{
            endReason?: string | undefined;
            ended: boolean;
            lastFlagType?: string | undefined;
            warningCount: number;
        }, {
            warningCount: import("convex/values").VFloat64<number, "required">;
            ended: import("convex/values").VBoolean<boolean, "required">;
            endReason: import("convex/values").VString<string | undefined, "optional">;
            lastFlagType: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "endReason" | "ended" | "lastFlagType" | "warningCount">, "required", string>;
        destroyJobId: import("convex/values").VId<import("convex/values").GenericId<"_scheduled_functions"> | undefined, "optional">;
    }, "required", "activePersonaKey" | "caseId" | "destroyJobId" | "expiresAt" | "personaChatState" | "sharedFiles" | "startTime" | "unlockedAt" | "unlockedReferredIds" | `personaChatState.${string}` | `sharedFiles.${string}` | `unlockedAt.${string}`>, {
        by_case: ["caseId", "_creationTime"];
        by_expiry: ["expiresAt", "_creationTime"];
    }, {}, {}>;
    runMessages: import("convex/server").TableDefinition<import("convex/values").VObject<{
        content: string;
        personaKey: string;
        role: "assistant" | "user";
        runId: import("convex/values").GenericId<"runs">;
    }, {
        runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
        personaKey: import("convex/values").VString<string, "required">;
        role: import("convex/values").VUnion<"assistant" | "user", [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"assistant", "required">], "required", never>;
        content: import("convex/values").VString<string, "required">;
    }, "required", "content" | "personaKey" | "role" | "runId">, {
        by_run_persona: ["runId", "personaKey", "_creationTime"];
    }, {}, {}>;
    streamingReplies: import("convex/server").TableDefinition<import("convex/values").VObject<{
        personaKey: string;
        runId: import("convex/values").GenericId<"runs">;
        status: "done" | "error" | "streaming";
        text: string;
    }, {
        runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
        personaKey: import("convex/values").VString<string, "required">;
        text: import("convex/values").VString<string, "required">;
        status: import("convex/values").VUnion<"done" | "error" | "streaming", [import("convex/values").VLiteral<"streaming", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"error", "required">], "required", never>;
    }, "required", "personaKey" | "runId" | "status" | "text">, {
        by_run_persona: ["runId", "personaKey", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
