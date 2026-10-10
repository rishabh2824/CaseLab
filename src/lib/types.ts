export type { AdminRole } from "../../convex/lib/constants.js";
export type {
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload as ReferralEdge,
} from "../../convex/models/cases.js";

import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import type { AdminRole } from "../../convex/lib/constants.js";
import type {
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
} from "../../convex/models/cases.js";

export type DraftFileEntry = Omit<FileEntryPayload, "file"> & {
	file?: File | FileRefPayload | null;
};

export type Persona = Omit<PersonaPayload, "profilePhoto" | "files"> & {
	profilePhoto: File | FileRefPayload | null;
	files: DraftFileEntry[];
};

export type AdminRow = {
	_id: Id<"admins">;
	email: string;
	name?: string;
	role: AdminRole;
};

// What the backend returns to the client, derived from the functions themselves.
type RunState = FunctionReturnType<typeof api.simulations.get>;
export type Contact = RunState["contacts"][number];
export type SharedFile = RunState["sharedFiles"][number];
export type ChatMessage = FunctionReturnType<
	typeof api.simulations.getPersonaHistory
>["messages"][number];
export type ExportPersonaOut = FunctionReturnType<
	typeof api.simulations.exportRun
>["personas"][number];
export type CaseSummary = FunctionReturnType<typeof api.cases.listAll>[number];
