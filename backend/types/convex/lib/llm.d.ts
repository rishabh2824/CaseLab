export type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};
export declare const PERSONA_REPLY_SCHEMA: {
    type: string;
    properties: {
        reply: {
            type: string;
            description: string;
        };
        introduce: {
            type: string;
            items: {
                type: string;
            };
            description: string;
        };
        send_files: {
            type: string;
            items: {
                type: string;
            };
            description: string;
        };
    };
    required: string[];
    additionalProperties: boolean;
};
export type StreamDelta = {
    type: "delta";
    text: string;
};
export declare function personaReplyStream(messages: ChatMessage[]): AsyncGenerator<StreamDelta>;
export declare const RECENT_HISTORY_LIMIT = 10;
export type HarassmentLabel = "normal" | "nonsense";
export declare function classifyHarassment(userMessage: string, conversation: ChatMessage[]): Promise<HarassmentLabel>;
