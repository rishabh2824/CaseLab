import { type Infer } from "convex/values";
export declare const fileRefValidator: import("convex/values").VUnion<{
    content_type?: string | null | undefined;
    file_id?: string | null | undefined;
    file_name: string;
    object_key: string;
} | null, [import("convex/values").VNull<null, "required">, import("convex/values").VObject<{
    content_type?: string | null | undefined;
    file_id?: string | null | undefined;
    file_name: string;
    object_key: string;
}, {
    file_id: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
    object_key: import("convex/values").VString<string, "required">;
    file_name: import("convex/values").VString<string, "required">;
    content_type: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
}, "required", "content_type" | "file_id" | "file_name" | "object_key">], "required", "content_type" | "file_id" | "file_name" | "object_key">;
export declare const fileEntryValidator: import("convex/values").VObject<{
    file?: {
        content_type?: string | null | undefined;
        file_id?: string | null | undefined;
        file_name: string;
        object_key: string;
    } | null | undefined;
    perceived_contents?: string | null | undefined;
    share_conditions?: string | null | undefined;
}, {
    file: import("convex/values").VUnion<{
        content_type?: string | null | undefined;
        file_id?: string | null | undefined;
        file_name: string;
        object_key: string;
    } | null | undefined, [import("convex/values").VNull<null, "required">, import("convex/values").VObject<{
        content_type?: string | null | undefined;
        file_id?: string | null | undefined;
        file_name: string;
        object_key: string;
    }, {
        file_id: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
        object_key: import("convex/values").VString<string, "required">;
        file_name: import("convex/values").VString<string, "required">;
        content_type: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
    }, "required", "content_type" | "file_id" | "file_name" | "object_key">], "optional", "content_type" | "file_id" | "file_name" | "object_key">;
    share_conditions: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
    perceived_contents: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
}, "required", "file" | "file.content_type" | "file.file_id" | "file.file_name" | "file.object_key" | "perceived_contents" | "share_conditions">;
export declare const personaPayloadValidator: import("convex/values").VObject<{
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
}, {
    id: import("convex/values").VString<string, "required">;
    name: import("convex/values").VString<string, "required">;
    role: import("convex/values").VString<string, "required">;
    profile_photo: import("convex/values").VUnion<{
        content_type?: string | null | undefined;
        file_id?: string | null | undefined;
        file_name: string;
        object_key: string;
    } | null | undefined, [import("convex/values").VNull<null, "required">, import("convex/values").VObject<{
        content_type?: string | null | undefined;
        file_id?: string | null | undefined;
        file_name: string;
        object_key: string;
    }, {
        file_id: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
        object_key: import("convex/values").VString<string, "required">;
        file_name: import("convex/values").VString<string, "required">;
        content_type: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
    }, "required", "content_type" | "file_id" | "file_name" | "object_key">], "optional", "content_type" | "file_id" | "file_name" | "object_key">;
    known_facts: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
    personality_traits: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
    availability_minutes: import("convex/values").VUnion<number | null | undefined, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
    files: import("convex/values").VArray<{
        file?: {
            content_type?: string | null | undefined;
            file_id?: string | null | undefined;
            file_name: string;
            object_key: string;
        } | null | undefined;
        perceived_contents?: string | null | undefined;
        share_conditions?: string | null | undefined;
    }[] | undefined, import("convex/values").VObject<{
        file?: {
            content_type?: string | null | undefined;
            file_id?: string | null | undefined;
            file_name: string;
            object_key: string;
        } | null | undefined;
        perceived_contents?: string | null | undefined;
        share_conditions?: string | null | undefined;
    }, {
        file: import("convex/values").VUnion<{
            content_type?: string | null | undefined;
            file_id?: string | null | undefined;
            file_name: string;
            object_key: string;
        } | null | undefined, [import("convex/values").VNull<null, "required">, import("convex/values").VObject<{
            content_type?: string | null | undefined;
            file_id?: string | null | undefined;
            file_name: string;
            object_key: string;
        }, {
            file_id: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
            object_key: import("convex/values").VString<string, "required">;
            file_name: import("convex/values").VString<string, "required">;
            content_type: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
        }, "required", "content_type" | "file_id" | "file_name" | "object_key">], "optional", "content_type" | "file_id" | "file_name" | "object_key">;
        share_conditions: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
        perceived_contents: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
    }, "required", "file" | "file.content_type" | "file.file_id" | "file.file_name" | "file.object_key" | "perceived_contents" | "share_conditions">, "optional">;
}, "required", "availability_minutes" | "files" | "id" | "known_facts" | "name" | "personality_traits" | "profile_photo" | "profile_photo.content_type" | "profile_photo.file_id" | "profile_photo.file_name" | "profile_photo.object_key" | "role">;
export declare const referralEdgeValidator: import("convex/values").VObject<{
    conditions?: string | null | undefined;
    from_id: string;
    to_id: string;
}, {
    from_id: import("convex/values").VString<string, "required">;
    to_id: import("convex/values").VString<string, "required">;
    conditions: import("convex/values").VUnion<string | null | undefined, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "optional", never>;
}, "required", "conditions" | "from_id" | "to_id">;
export type FileRefPayload = Infer<typeof fileRefValidator>;
export type FileEntryPayload = Infer<typeof fileEntryValidator>;
export type PersonaPayload = Infer<typeof personaPayloadValidator>;
export type ReferralEdgePayload = Infer<typeof referralEdgeValidator>;
