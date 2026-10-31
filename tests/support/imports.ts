// Reads the import specifiers out of a source file's text, so the boundary tests can check them without a filesystem (the convex project runs in the edge runtime, which has none).

export type SourceImport = { spec: string; isType: boolean };

// Drops comments, so an import mentioned in prose is not counted.
const withoutComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const STATIC_IMPORT =
	/\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

// Lists every module a file imports or re-exports from, marking `import type` and `export type` forms.
export function importsOf(source: string): SourceImport[] {
	const text = withoutComments(source);
	return [
		...[...text.matchAll(STATIC_IMPORT)].map((match) => ({
			spec: match[2] as string,
			isType: match[1] !== undefined,
		})),
		...[...text.matchAll(DYNAMIC_IMPORT)].map((match) => ({
			spec: match[1] as string,
			isType: false,
		})),
	];
}
