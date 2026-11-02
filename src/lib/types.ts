export type {
	AdminRole,
	CollaboratorAccess,
	CollaboratorPayload,
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload as ReferralEdge,
} from "#shared/validators.js";

import type { FunctionReturnType } from "convex/server";
import type { api } from "#convex/api.js";
import type {
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload,
} from "#shared/validators.js";

export type DraftFileEntry = Omit<FileEntryPayload, "file"> & {
	file?: File | FileRefPayload | null;
};

// A persona as the form edits it: empty values are null, and the submit step omits them from the payload.
export type Persona = Omit<
	PersonaPayload,
	"profilePhoto" | "availabilityMinutes" | "files"
> & {
	profilePhoto: File | FileRefPayload | null;
	availabilityMinutes: number | null;
	files: DraftFileEntry[];
};

// The personas and referrals that make up a case, as the form edits them.
export type GraphData = {
	personas: Persona[];
	referrals: ReferralEdgePayload[];
};

// The case information the form edits besides its personas.
export type CaseInfo = {
	name: string;
	brief: string;
	commonInformation: string;
	duration: number | null;
	accessCode: string;
};

// What the backend returns to the client, derived from the functions themselves.
export type AdminRow = FunctionReturnType<typeof api.admins.listAll>[number];
type RunState = FunctionReturnType<typeof api.runs.get>;
export type Contact = RunState["contacts"][number];
export type SharedFile = RunState["sharedFiles"][number];
export type ChatMessage = FunctionReturnType<
	typeof api.runs.getPersonaHistory
>["messages"][number];
export type ExportPersonaOut = FunctionReturnType<
	typeof api.runs.exportRun
>["personas"][number];
export type CaseSummary = FunctionReturnType<typeof api.cases.listAll>[number];

// Where the case form starts: blank, a copy of a template, or a saved case being edited.
export type CaseSource =
	| { kind: "new" }
	| { kind: "template"; id: string }
	| { kind: "edit"; id: string };
