import type { Api } from "./types.js";

// `as const` narrows SUPER/ADMIN to the literal numbers 1/2 (not `number`);
// `satisfies Record<string, Api<"AdminRole">>` checks those literals against
// the backend's generated AdminRole (1 | 2) — a mismatch is a compile error,
// not a runtime surprise. Object.freeze adds runtime immutability on top.
export const ADMIN_ROLE = Object.freeze({
	SUPER: 1,
	ADMIN: 2,
} as const) satisfies Record<string, Api<"AdminRole">>;

export const MAX_MESSAGE_WORDS = 50;
