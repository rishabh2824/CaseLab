/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import { importsOf, type SourceImport } from "../tests/support/imports";

// What a file in shared/ may import: files in shared/, convex/values (validators.ts needs `v`, studentErrors.ts needs ConvexError), and only types from convex/server. Anything else would drag server code or the schema into the browser bundle.
function sharedViolations(imports: SourceImport[]): string[] {
	return imports
		.filter(({ spec, isType }) => {
			if (spec.startsWith("./")) return false;
			if (spec === "convex/values") return false;
			if (spec === "convex/server") return !isType;
			return true;
		})
		.map(({ spec }) => spec);
}

describe("shared/ stays safe for the browser", () => {
	// Raw source of every non-test module in shared/, keyed by path. Read as text, because the edge runtime has no filesystem.
	const sources = import.meta.glob(
		["./shared/**/*.ts", "!./shared/**/*.test.ts"],
		{
			query: "?raw",
			import: "default",
			eager: true,
		},
	) as Record<string, string>;

	// Tests that shared/ imports nothing but its own files, convex/values and type-only convex/server.
	it("imports only shared files, convex/values and types from convex/server", () => {
		expect(Object.keys(sources).length).toBeGreaterThan(0);
		const offenders = Object.entries(sources).flatMap(([path, source]) =>
			sharedViolations(importsOf(source)).map((spec) => `${path}: ${spec}`),
		);
		expect(offenders).toEqual([]);
	});

	// Tests that the check itself accepts what shared/ needs and rejects server code, so a loosened rule can't pass silently.
	it("accepts the allowed imports and rejects the rest", () => {
		const allowed = importsOf(`
			import { v } from "convex/values";
			import type { Infer } from "convex/values";
			import type { GenericId } from "convex/server";
			import { caseGraph } from "./caseGraph";
		`);
		expect(sharedViolations(allowed)).toEqual([]);

		const rejected = importsOf(`
			import { query } from "convex/server";
			import { ctx } from "../_generated/server";
			import { runs } from "../model/runs";
			import { z } from "zod";
		`);
		expect(sharedViolations(rejected)).toEqual([
			"convex/server",
			"../_generated/server",
			"../model/runs",
			"zod",
		]);
	});
});
