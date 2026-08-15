// A frontend-internal numeric enum -- unrelated to Convex's own admin role representation
// (a "super"|"admin" string; see AdminAuth.svelte, which converts at the boundary). Used to
// be the old FastAPI backend's own numeric enum, mirrored via the generated OpenAPI schema;
// now that pipeline is gone, this is just the plain source of truth it always conceptually was.
export const ADMIN_ROLE = Object.freeze({
	SUPER: 1,
	ADMIN: 2,
} as const);

export type AdminRole = (typeof ADMIN_ROLE)[keyof typeof ADMIN_ROLE];

export const MAX_MESSAGE_WORDS = 50;
