// Constants shared by the Convex backend and the browser. Kept free of Convex imports so the client bundle doesn't pull in the schema.

export type AdminRole = "super" | "admin";

export const RUN_LIFETIME_MINUTES = 120;

export const MAX_MESSAGE_WORDS = 50;

export const ACCESS_CODE_FORMAT = /^[a-z]+$/;
