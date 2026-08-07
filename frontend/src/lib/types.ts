import type { components } from "./api/schema";

type S = components["schemas"];

export type Api<K extends keyof S> = S[K];

export type Contact = S["ContactOut"];
export type SharedFile = S["SharedFileOut"];
export type RunState = S["RunStateResponse"];

export type DraftFileEntry = Omit<Api<"FileEntry">, "file"> & {
	file?: File | Api<"FileRef"> | null;
};

export type Persona = Omit<Api<"PersonaPayload">, "profile_photo" | "files"> & {
	profile_photo: File | Api<"FileRef"> | null;
	files: DraftFileEntry[];
};

export type ReferralEdge = Api<"ReferralEdgePayload">;

export type NewContact = Contact;

export type TurnMeta = Api<"TurnMeta">;

export type StreamEvent =
	| { type: "meta"; data: TurnMeta }
	| { type: "delta"; data: Api<"DeltaFrame"> }
	| { type: "done"; data: Api<"DoneFrame"> }
	| { type: "error"; data: Api<"ErrorFrame"> };

export type PersonaFieldErrors = Partial<
	Record<"name" | "role" | "availability", string>
>;
