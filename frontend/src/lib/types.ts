// Domain types for the app. Wire shapes are re-exported from the generated
// OpenAPI schema (src/lib/api/schema.d.ts, regenerate with `pnpm gen:api`)
// rather than duplicated here; this file adds only what OpenAPI can't express
// — draft (in-progress-edit) shapes and the hand-maintained SSE event union.
import type { components } from "./api/schema";

type S = components["schemas"];

// --- Wire types ---------------------------------------------------------

export type FileRef = S["FileRef"];
export type FileEntry = S["FileEntry"];
export type PersonaPayload = S["PersonaPayload"];
export type ReferralEdgePayload = S["ReferralEdgePayload"];
export type CasePayload = S["CasePayload"];
// PUT-only: CasePayload plus the version the client loaded, so the backend can
// reject a save with a 409 if someone else saved the case first (see
// services/cases.py::updateCase and CaseForm.svelte's conflict handling).
export type CaseUpdatePayload = S["CaseUpdatePayload"];

export type PersonaOut = S["PersonaOut"];
export type ReferralOut = S["ReferralOut"];
export type CaseDetail = S["CaseDetail"];
export type CaseSummary = S["CaseSummary"];
export type CaseDetailResponse = S["CaseDetailResponse"];
// GET /api/cases/demo — a trimmed-down, read-only CaseDetail (no id/version/
// owner/collaborators) for the "View demo" admin-panel screen (DemoCaseView.svelte).
export type DemoCaseDetail = S["DemoCaseDetail"];
export type DemoCaseResponse = S["DemoCaseResponse"];
export type CaseListResponse = S["CaseListResponse"];
export type CaseCreatedResponse = S["CaseCreatedResponse"];
export type CaseDeletedResponse = S["CaseDeletedResponse"];
// GET /api/cases/{id}/version — polled while a case is open for editing to
// detect a concurrent save (CaseForm.svelte).
export type CaseVersionResponse = S["CaseVersionResponse"];

export type ChatMessage = S["ChatMessage"];
export type Contact = S["ContactOut"];
export type SharedFile = S["SharedFileOut"];
export type RunState = S["RunStateResponse"];
export type ExportPersonaOut = S["ExportPersonaOut"];
export type ExportResponse = S["ExportResponse"];
export type NotesResponse = S["NotesResponse"];

// submitCase.js uploads File-valued photos/attachments to Spaces via this
// endpoint before building the CasePayload it sends to /api/cases.
export type PresignUploadRequest = S["PresignUploadRequest"];
export type PresignUploadResponse = S["PresignUploadResponse"];

// Request bodies for the simulation endpoints (student/run.svelte.ts).
export type StartSimulationPayload = S["StartSimulationPayload"];
export type SendMessagePayload = S["SendMessagePayload"];
export type NotesPayload = S["NotesPayload"];

// Admin Google sign-in (SignInButton.svelte).
export type LoginRequest = S["LoginRequest"];
export type LoginResponse = S["LoginResponse"];

// Admin management (admin/admins/+page.svelte).
export type AdminOut = S["AdminOut"];
export type AddAdminRequest = S["AddAdminRequest"];
export type AdminDeletedResponse = S["AdminDeletedResponse"];

// `1 | 2`, generated from backend/models/admin.py's AdminRole IntEnum. The
// frontend's own ADMIN_ROLE constant (constants.ts, converted alongside the
// rest of Tier A) gets a `satisfies AdminRole` check to keep the two in
// lockstep.
export type AdminRole = S["AdminRole"];

// --- Personas + referral edges (flat graph) --------------------------------
//
// The flat shape CaseForm/PersonaFields edit in memory: personas and referral
// edges are held as sibling arrays (see CaseForm.svelte's $state: personas,
// referrals, roots), not a nested tree — a persona has no embedded referrals
// field, and a referral edge has no embedded persona. A persona being edited
// holds a browser File for any photo/attachment that hasn't been uploaded
// yet, and the wire FileRef once it has (see isPendingUpload).

// `file?:` (optional key, not a required key typed `| undefined`) matches
// FileEntry's own optionality — CaseForm.svelte normalizes raw PersonaOut
// data (loaded from the API) straight into this shape, and FileEntry.file is
// an optional key so it may genuinely be absent, not just null.
export type DraftFileEntry = Omit<FileEntry, "file"> & {
	file?: File | FileRef | null;
};

export type Persona = Omit<PersonaPayload, "profile_photo" | "files"> & {
	profile_photo: File | FileRef | null;
	files: DraftFileEntry[];
};

// Identical shape on the wire whether it's a request or a response — a
// referral edge is just {from_id, to_id, conditions}, nothing to diverge on.
export type ReferralEdge = ReferralEdgePayload;

export const isPendingUpload = (
	value: File | FileRef | null | undefined,
): value is File => value instanceof File;

// --- SSE turn events -------------------------------------------------------
//
// Hand-maintained: POST /api/simulations/{run_id}/message is an
// EventSourceResponse (services/simulation/service.py's reply()/
// streamMessage()), invisible to OpenAPI. Keep these in sync with that
// file's `sse(...)` calls if the payload shapes change.

// A newly-unlocked referred persona, as sent inside meta.new_contacts.
// Same shape as Contact (both via ContactOut, which strips secrets before
// browser delivery). applyMeta patches in `available: true` for the newly-unlocked contact.
export type NewContact = Contact;

export type TurnMeta = {
	new_contacts: NewContact[];
	shared_files: SharedFile[];
	chat_ended: boolean;
	chat_end_reason: string | null;
	warning_count: number;
};

export type StreamEvent =
	| { type: "meta"; data: TurnMeta }
	| { type: "delta"; data: { text?: string } }
	| { type: "done"; data: { reply?: string; history?: ChatMessage[] } }
	| { type: "error"; data: { detail?: string } };

// --- Persona form validation ------------------------------------------------

export type PersonaFieldErrors = Partial<
	Record<"name" | "role" | "availability", string>
>;
