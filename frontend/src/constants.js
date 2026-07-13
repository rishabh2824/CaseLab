// Mirrors backend/models/admin.py's AdminRole(IntEnum) — the single source
// of truth for admin role values on this side, so `1`/`2` never has to be
// written directly at a comparison site.
export const ADMIN_ROLE = Object.freeze({
    SUPER: 1,
    ADMIN: 2,
})

// Mirrors backend/services/simulation/service.py's MAX_USER_MESSAGE_WORDS —
// the server is the actual enforcement point; this only lets the chat input
// give instant feedback instead of a round-trip rejection.
export const MAX_MESSAGE_WORDS = 50
