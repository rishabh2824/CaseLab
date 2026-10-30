// Constants shared by the Convex backend and the browser. Only type imports from Convex, so the client bundle doesn't pull in the schema.

import type { Infer } from "convex/values";
import type { adminRole } from "../schema";

export type AdminRole = Infer<typeof adminRole>;

export const MAX_DURATION_MINUTES = 120;

// Extra time after a case's duration before its run is deleted.
export const GRACE_PERIOD_MINUTES = 15;

// Hard cap on a run's lifetime. Leaves room for the grace period after the longest allowed duration.
export const RUN_LIFETIME_MINUTES = 240;

export const MAX_MESSAGE_WORDS = 50;

// Backstop for messages whose few "words" are enormous, which the word limit alone lets through.
export const MAX_MESSAGE_CHARS = 2000;

export const ACCESS_CODE_FORMAT = /^[a-z]+$/;
