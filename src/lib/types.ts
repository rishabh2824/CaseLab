export type { AdminRole } from "../../convex/lib/constants.js";
export type {
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload as ReferralEdge,
} from "../../convex/models/cases.js";
export type { CaseSummary } from "../../convex/services/cases.js";
export type {
	ChatMessageOut as ChatMessage,
	ContactOut as Contact,
	ExportPersonaOut,
	SharedFileOut as SharedFile,
} from "../../convex/services/simulations.js";

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
