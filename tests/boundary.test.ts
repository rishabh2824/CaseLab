import { describe, expect, it } from "vitest";
import { importsOf, type SourceImport } from "./support/imports";

// The browser reaches the repo's convex/ folder only through aliases: any of shared/ (#shared/*), and from the generated folder just the API and the data model types (#convex/api.js, #convex/dataModel.js). That keeps _generated/server and everything under model/ out of the bundle. npm packages such as convex/values or convex-svelte are not the repo's folder and are not checked.
const ALLOWED_GENERATED = new Set(["#convex/api.js", "#convex/dataModel.js"]);

function browserViolations(imports: SourceImport[]): string[] {
	return imports
		.filter(({ spec }) => {
			// A relative path into convex/ skips the aliases.
			if (spec.startsWith(".") && spec.split("/").includes("convex"))
				return true;
			if (spec.startsWith("#convex/")) return !ALLOWED_GENERATED.has(spec);
			return false;
		})
		.map(({ spec }) => spec);
}

describe("src/ stays on the browser side of convex/", () => {
	// Raw source of every file in src/. Read as text, the same way convex/authz.test.ts reads the backend.
	const sources = import.meta.glob("../src/**/*.{ts,svelte}", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>;

	// Tests that nothing in src/ reaches into convex/ except through the allowed aliases.
	it("imports convex/ only through #shared/* and #convex/api.js or #convex/dataModel.js", () => {
		expect(Object.keys(sources).length).toBeGreaterThan(0);
		const offenders = Object.entries(sources).flatMap(([path, source]) =>
			browserViolations(importsOf(source)).map((spec) => `${path}: ${spec}`),
		);
		expect(offenders).toEqual([]);
	});

	// Tests that the check accepts the aliases and packages, and rejects server code and relative paths into convex/.
	it("accepts the allowed imports and rejects the rest", () => {
		const allowed = importsOf(`
			import { api } from "#convex/api.js";
			import type { Id } from "#convex/dataModel.js";
			import { countWords } from "#shared/rules.js";
			import { v } from "convex/values";
			import { useQuery } from "convex-svelte";
			import { x } from "#lib/format.js";
		`);
		expect(browserViolations(allowed)).toEqual([]);

		const rejected = importsOf(`
			import { query } from "#convex/server.js";
			import { runs } from "../../convex/model/runs.js";
			import { api } from "../../../convex/_generated/api.js";
		`);
		expect(browserViolations(rejected)).toEqual([
			"#convex/server.js",
			"../../convex/model/runs.js",
			"../../../convex/_generated/api.js",
		]);
	});
});
