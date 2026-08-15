// tsc (tsconfig.types.json) excludes convex/_generated, so it never emits a copy of it
// under types/ -- but every emitted .d.ts under types/ still has import specifiers like
// "../_generated/dataModel" (copied through verbatim from the source .ts files), which only
// resolve if something real sits at that relative path. Convex's own _generated/*.d.ts are
// already real .d.ts files (not .ts source), so the fix is just to copy them into place
// rather than recompile them.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "convex", "_generated");
const dest = join(root, "types", "_generated");

cpSync(src, dest, {
	recursive: true,
	// Only the top-level .d.ts declarations (api.d.ts, dataModel.d.ts, server.d.ts) -- not
	// their .js counterparts (frontend only ever imports types, never the runtime code) and
	// not ai/ (Convex's MCP-server guidelines doc, irrelevant here).
	filter: (path) => path.endsWith(".d.ts") || !path.includes("."),
});
