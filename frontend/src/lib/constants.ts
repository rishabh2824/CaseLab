import type { Api } from "./types.js";

export const ADMIN_ROLE = Object.freeze({
	SUPER: 1,
	ADMIN: 2,
} as const) satisfies Record<string, Api<"AdminRole">>;

export const MAX_MESSAGE_WORDS = 50;
