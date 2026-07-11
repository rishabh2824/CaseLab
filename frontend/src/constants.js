// Mirrors backend/models/admin.py's AdminRole(IntEnum) — the single source
// of truth for admin role values on this side, so `1`/`2` never has to be
// written directly at a comparison site.
export const ADMIN_ROLE = Object.freeze({
    SUPER: 1,
    ADMIN: 2,
})
