// Domain types shared across the frontend. Re-exported (aliased to the names this app has
// always used) from newBackend's own compiled declarations, not hand-copied -- see below for
// how, and why this only became possible partway through the migration.
//
// Earlier in this migration, a plain `import type {...} from "../../../newBackend/convex/
// models/cases.js"` (a relative import straight into newBackend's .ts SOURCE) was tried and
// reverted: newBackend isn't a workspace package of this project, and TypeScript type-checks
// every .ts file it walks into under the IMPORTING project's own tsconfig -- so that one
// import dragged this project's strict noUncheckedIndexedAccess setting (not enabled in
// newBackend's own tsconfig) into unrelated newBackend files (e.g. services/admins.ts,
// lib/replyStream.ts), surfacing real but irrelevant strictness errors purely from importing
// a single type.
//
// The fix isn't avoiding the import, it's importing compiled .d.ts instead of .ts source:
// `npm run build:types` (newBackend/package.json) runs `tsc --emitDeclarationOnly` over
// convex/ into newBackend/types/, mirroring its structure. This project's tsconfig.json
// already sets `skipLibCheck: true` -- which skips checking the CONTENTS of any .d.ts file,
// generated or hand-written, entirely. A .ts source file gets no such exemption; a .d.ts
// does, regardless of where it came from. So importing from newBackend/types/ (compiled
// declarations) instead of newBackend/convex/ (source) gets the exact same real types with
// none of the coupling: this project's type-checker resolves the shapes but never walks into
// newBackend's own strictness settings to do it.
//
// Run `npm run build:types` in newBackend/ after changing any type re-exported below.
export type {
	FileRefPayload,
	FileEntryPayload,
	PersonaPayload,
	ReferralEdgePayload as ReferralEdge,
} from "../../../newBackend/types/models/cases.js";

export type {
	ContactOut as Contact,
	SharedFileOut as SharedFile,
	ChatMessageOut as ChatMessage,
	ExportPersonaOut,
} from "../../../newBackend/types/services/simulations.js";

import type { FileEntryPayload, FileRefPayload, PersonaPayload } from "../../../newBackend/types/models/cases.js";

// The case-authoring UI (CaseGraphEditor/PersonaFields/draft.ts) edits an in-progress
// upload as a raw `File` before it's been presigned/uploaded to Spaces -- PersonaPayload/
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
