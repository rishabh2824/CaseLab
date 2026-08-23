// Domain types shared across the frontend. Re-exported (aliased to the names this app has
// always used) from convex's own source -- convex/tsconfig.json matches this project's
// strictness (noUncheckedIndexedAccess), so importing convex .ts files directly no longer
// drags in unrelated strictness errors.

export type {
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
	ReferralEdgePayload as ReferralEdge,
} from "../../convex/models/cases.js";
export type { AdminRole } from "../../convex/schema.js";
export type {
	ChatMessageOut as ChatMessage,
	ContactOut as Contact,
	ExportPersonaOut,
	SharedFileOut as SharedFile,
} from "../../convex/services/simulations.js";

import type {
	FileEntryPayload,
	FileRefPayload,
	PersonaPayload,
} from "../../convex/models/cases.js";
import type { AdminRole } from "../../convex/schema.js";

// The case-authoring UI (CaseGraphEditor/PersonaFields/draft.ts) edits an in-progress
// upload as a raw `File` before it's been uploaded to Convex storage -- PersonaPayload/
// FileEntryPayload (the wire shape Convex actually validates) only ever see the resolved
// FileRefPayload, never a File. Draft-only, so these stay local rather than living
// alongside the wire types above.
export type DraftFileEntry = Omit<FileEntryPayload, "file"> & {
	file?: File | FileRefPayload | null;
};

export type Persona = Omit<PersonaPayload, "profile_photo" | "files"> & {
	profile_photo: File | FileRefPayload | null;
	files: DraftFileEntry[];
};

export type PersonaFieldErrors = Partial<
	Record<"name" | "role" | "availability", string>
>;

// A Convex `admins` document as api/admins:listAll returns it.
export type AdminRow = {
	_id: string;
	email: string;
	name?: string;
	role: AdminRole;
};
