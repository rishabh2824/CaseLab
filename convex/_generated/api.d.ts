/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admins from "../admins.js";
import type * as auth from "../auth.js";
import type * as cases from "../cases.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_caseGraph from "../lib/caseGraph.js";
import type * as lib_caseRules from "../lib/caseRules.js";
import type * as lib_caseStructure from "../lib/caseStructure.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_llm from "../lib/llm.js";
import type * as lib_prompt from "../lib/prompt.js";
import type * as lib_studentErrors from "../lib/studentErrors.js";
import type * as lib_turnState from "../lib/turnState.js";
import type * as migrations from "../migrations.js";
import type * as models_cases from "../models/cases.js";
import type * as models_legacyCases from "../models/legacyCases.js";
import type * as services_adminFunctions from "../services/adminFunctions.js";
import type * as services_admins from "../services/admins.js";
import type * as services_cases from "../services/cases.js";
import type * as services_files from "../services/files.js";
import type * as services_simulationReads from "../services/simulationReads.js";
import type * as services_turnReply from "../services/turnReply.js";
import type * as simulations from "../simulations.js";
import type * as turn from "../turn.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admins: typeof admins;
  auth: typeof auth;
  cases: typeof cases;
  files: typeof files;
  http: typeof http;
  "lib/caseGraph": typeof lib_caseGraph;
  "lib/caseRules": typeof lib_caseRules;
  "lib/caseStructure": typeof lib_caseStructure;
  "lib/constants": typeof lib_constants;
  "lib/llm": typeof lib_llm;
  "lib/prompt": typeof lib_prompt;
  "lib/studentErrors": typeof lib_studentErrors;
  "lib/turnState": typeof lib_turnState;
  migrations: typeof migrations;
  "models/cases": typeof models_cases;
  "models/legacyCases": typeof models_legacyCases;
  "services/adminFunctions": typeof services_adminFunctions;
  "services/admins": typeof services_admins;
  "services/cases": typeof services_cases;
  "services/files": typeof services_files;
  "services/simulationReads": typeof services_simulationReads;
  "services/turnReply": typeof services_turnReply;
  simulations: typeof simulations;
  turn: typeof turn;
  uploads: typeof uploads;
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
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
