export declare function elapsedMinutes(startTime: number, now: number): number;
export type Availability = {
    available: boolean;
    availableIn: number | null;
    expiresIn: number | null;
};
export declare function personaAvailability(availabilityDuration: number | null, availableAtMinutes: number, elapsed: number): Availability;
export type ChatStateMap = Record<string, {
    warningCount: number;
    ended: boolean;
    endReason?: string;
}>;
export type ChatStateOut = {
    ended: boolean;
    endReason: string | null;
    warningCount: number;
};
export declare function getChatState(personaChatState: ChatStateMap, personaId: string): ChatStateOut;
export declare const NONSENSE_THRESHOLD = 3;
export declare function boundaryReply(personaName: string, shouldEnd: boolean): string;
