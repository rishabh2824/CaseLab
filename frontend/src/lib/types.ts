// Domain types for the app. Wire shapes come from the generated OpenAPI
// schema (src/lib/api/schema.d.ts, regenerate with `pnpm gen:api`) via the
// Api<K> helper below — this file adds only what OpenAPI can't express: a
// few wire aliases whose app-facing name differs from the schema key, draft
// (in-progress-edit) shapes, and the hand-maintained SSE event union.
import type { components } from "./api/schema";

type S = components["schemas"];

// A wire type straight off the generated schema, referenced by its schema
// key — `Api<"CaseDetail">` instead of a dedicated `export type CaseDetail =
// S["CaseDetail"]` line here. A new endpoint needs no edit to this file at
// all: reference the schema key directly at the call site. A renamed or
// deleted schema key then becomes a compile error exactly where it's used,
// rather than a silently stale alias sitting unused in this barrel.
export type Api<K extends keyof S> = S[K];

// --- Wire types renamed for readability (not a 1:1 schema-key match) -------

export type Contact = S["ContactOut"];
export type SharedFile = S["SharedFileOut"];
export type RunState = S["RunStateResponse"];

// --- Personas + referral edges (flat graph) --------------------------------
//
// The flat shape CaseForm/PersonaFields edit in memory: personas and referral
// edges are held as sibling arrays (see CaseForm.svelte's $state: personas,
// referrals, roots), not a nested tree — a persona has no embedded referrals
// field, and a referral edge has no embedded persona. A persona being edited
// holds a browser File for any photo/attachment that hasn't been uploaded
// yet, and the wire FileRef once it has.

// `file?:` (optional key, not a required key typed `| undefined`) matches
// FileEntry's own optionality — CaseForm.svelte normalizes raw persona data
// (loaded from the API) straight into this shape, and FileEntry.file is an
// optional key so it may genuinely be absent, not just null.
export type DraftFileEntry = Omit<Api<"FileEntry">, "file"> & {
	file?: File | Api<"FileRef"> | null;
};

export type Persona = Omit<Api<"PersonaPayload">, "profile_photo" | "files"> & {
	profile_photo: File | Api<"FileRef"> | null;
	files: DraftFileEntry[];
};

// Identical shape on the wire whether it's a request or a response — a
// referral edge is just {from_id, to_id, conditions}, nothing to diverge on.
export type ReferralEdge = Api<"ReferralEdgePayload">;

// --- SSE turn events -------------------------------------------------------
//
// POST /api/simulations/{run_id}/message streams these frames over SSE
// (services/simulation/service.py's `sse(...)` calls). The frame shapes
// themselves come off the generated schema — main.py's custom openapi()
// (api/simulations.py's describeMessageStream) hand-registers them there,
// since EventSourceResponse has no response_model for FastAPI to see. Only
// the SSE event-name -> frame mapping below stays hand-maintained; a oneOf
// response body can't express that association on its own.

// A newly-unlocked referred persona, as sent inside meta.new_contacts.
// Same shape as Contact (both via ContactOut, which strips secrets before
// browser delivery). applyMeta patches in `available: true` for the newly-unlocked contact.
export type NewContact = Contact;

export type TurnMeta = Api<"TurnMeta">;

export type StreamEvent =
	| { type: "meta"; data: TurnMeta }
	| { type: "delta"; data: Api<"DeltaFrame"> }
	| { type: "done"; data: Api<"DoneFrame"> }
	| { type: "error"; data: Api<"ErrorFrame"> };

// --- Persona form validation ------------------------------------------------

export type PersonaFieldErrors = Partial<
	Record<"name" | "role" | "availability", string>
>;
