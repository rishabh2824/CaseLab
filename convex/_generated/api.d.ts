/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as api_admins from "../api/admins.js";
import type * as api_cases from "../api/cases.js";
import type * as api_files from "../api/files.js";
import type * as api_simulations from "../api/simulations.js";
import type * as api_turn from "../api/turn.js";
import type * as api_uploads from "../api/uploads.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_adminFunctions from "../lib/adminFunctions.js";
import type * as lib_llm from "../lib/llm.js";
import type * as lib_prompt from "../lib/prompt.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_replyStream from "../lib/replyStream.js";
import type * as lib_turnState from "../lib/turnState.js";
import type * as models_cases from "../models/cases.js";
import type * as services_admins from "../services/admins.js";
import type * as services_cases from "../services/cases.js";
import type * as services_files from "../services/files.js";
import type * as services_simulationReads from "../services/simulationReads.js";
import type * as services_simulations from "../services/simulations.js";
import type * as services_turn from "../services/turn.js";
import type * as testFactories from "../testFactories.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "api/admins": typeof api_admins;
  "api/cases": typeof api_cases;
  "api/files": typeof api_files;
  "api/simulations": typeof api_simulations;
  "api/turn": typeof api_turn;
  "api/uploads": typeof api_uploads;
  auth: typeof auth;
  crons: typeof crons;
  http: typeof http;
  "lib/adminFunctions": typeof lib_adminFunctions;
  "lib/llm": typeof lib_llm;
  "lib/prompt": typeof lib_prompt;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/replyStream": typeof lib_replyStream;
  "lib/turnState": typeof lib_turnState;
  "models/cases": typeof models_cases;
  "services/admins": typeof services_admins;
  "services/cases": typeof services_cases;
  "services/files": typeof services_files;
  "services/simulationReads": typeof services_simulationReads;
  "services/simulations": typeof services_simulations;
  "services/turn": typeof services_turn;
  testFactories: typeof testFactories;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
