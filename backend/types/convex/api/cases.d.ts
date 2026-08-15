export declare const get: import("convex/server").RegisteredQuery<"public", {
    caseId: import("convex/values").GenericId<"cases">;
}, Promise<{
    _creationTime: number;
    _id: import("convex/values").GenericId<"cases">;
    accessCode?: string | undefined;
    brief: string;
    commonInformation?: string | undefined;
    duration?: number | undefined;
    name: string;
    ownerAdminId: import("convex/values").GenericId<"admins">;
    structure: any;
} | null>>;
export declare const getForEdit: import("convex/server").RegisteredQuery<"public", {
    caseId: import("convex/values").GenericId<"cases">;
}, Promise<{
    _creationTime: number;
    _id: import("convex/values").GenericId<"cases">;
    collaboratorAdminIds: import("convex/values").GenericId<"admins">[];
    accessCode?: string | undefined;
    brief: string;
    commonInformation?: string | undefined;
    duration?: number | undefined;
    name: string;
    ownerAdminId: import("convex/values").GenericId<"admins">;
    structure: any;
}>>;
export declare const listAll: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    _creationTime: number;
    _id: import("convex/values").GenericId<"cases">;
    accessCode?: string | undefined;
    brief: string;
    commonInformation?: string | undefined;
    duration?: number | undefined;
    name: string;
    ownerAdminId: import("convex/values").GenericId<"admins">;
    structure: any;
}[]>>;
export declare const deleteCase: import("convex/server").RegisteredMutation<"public", {
    caseId: import("convex/values").GenericId<"cases">;
}, Promise<void>>;
export declare const create: import("convex/server").RegisteredMutation<"public", {
    accessCode?: string | undefined;
    brief: string;
    collaboratorAdminIds: import("convex/values").GenericId<"admins">[];
    commonInformation?: string | undefined;
    duration?: number | undefined;
    name: string;
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
}, Promise<{
    caseId: import("../_generated/dataModel").Id<"cases">;
}>>;
export declare const update: import("convex/server").RegisteredMutation<"public", {
    accessCode?: string | undefined;
    brief: string;
    caseId: import("convex/values").GenericId<"cases">;
    collaboratorAdminIds: import("convex/values").GenericId<"admins">[];
    commonInformation?: string | undefined;
    duration?: number | undefined;
    name: string;
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
}, Promise<{
    caseId: import("convex/values").GenericId<"cases">;
}>>;
