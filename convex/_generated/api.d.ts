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
import type * as crons from "../crons.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as model_admins from "../model/admins.js";
import type * as model_caseStructure from "../model/caseStructure.js";
import type * as model_cases from "../model/cases.js";
import type * as model_files from "../model/files.js";
import type * as model_functions from "../model/functions.js";
import type * as model_llm from "../model/llm.js";
import type * as model_prompt from "../model/prompt.js";
import type * as model_reply from "../model/reply.js";
import type * as model_runs from "../model/runs.js";
import type * as shared_availability from "../shared/availability.js";
import type * as shared_caseGraph from "../shared/caseGraph.js";
import type * as shared_rules from "../shared/rules.js";
import type * as shared_studentErrors from "../shared/studentErrors.js";
import type * as shared_validators from "../shared/validators.js";
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
  crons: typeof crons;
  files: typeof files;
  http: typeof http;
  migrations: typeof migrations;
  "model/admins": typeof model_admins;
  "model/caseStructure": typeof model_caseStructure;
  "model/cases": typeof model_cases;
  "model/files": typeof model_files;
  "model/functions": typeof model_functions;
  "model/llm": typeof model_llm;
  "model/prompt": typeof model_prompt;
  "model/reply": typeof model_reply;
  "model/runs": typeof model_runs;
  "shared/availability": typeof shared_availability;
  "shared/caseGraph": typeof shared_caseGraph;
  "shared/rules": typeof shared_rules;
  "shared/studentErrors": typeof shared_studentErrors;
  "shared/validators": typeof shared_validators;
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
