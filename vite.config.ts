import path from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Set by playwright.config.ts's webServer.env for the `pnpm run build` it runs -- swaps
// convex-svelte for e2e/support/convexMock.svelte.ts everywhere it's imported, so the E2E
// build talks to a Node-bridged in-memory mock (see mockApi.ts) instead of opening a real
// WebSocket to a Convex deployment. Gated behind an env var (not always-on) so a normal
// `pnpm run build`/`pnpm run dev:web` still ships the real client.
const isE2E = process.env.E2E === "true";

export default defineConfig({
	resolve: isE2E
		? {
				alias: {
					"convex-svelte": path.resolve(
						dirname,
						"e2e/support/convexMock.svelte.ts",
					),
				},
			}
		: undefined,
	optimizeDeps: {
		// AdminAuth.svelte only ever reaches these via a runtime `import()` (see
		// +page.svelte) so students never fetch them -- but that also means Vite's
		// dev-server dependency scanner (which only follows static imports) never
		// discovers them at startup either. Without this, the *first* click on
		// "Admin Login" in a dev session makes Vite discover them mid-flow and
		// force a full page reload to re-bundle, which lands right in the middle of
		// the Google OAuth redirect and shows up as a transient error page.
		include: [
			"convex-svelte",
			"@mmailaender/convex-auth-svelte/svelte",
			"convex/server",
			"convex/browser",
		],
	},
	build: {
		rollupOptions: {
			// jsPDF only reaches for these (dynamically, via its own `.html()`/SVG
			// paths) through optionalDependencies — src/lib/student/pdf.ts never
			// calls those methods, only the plain text API, so these never
			// actually run. Left un-externalized, Rollup still statically finds
			// jsPDF's `import("html2canvas")`/`import("canvg")`/`import("dompurify")`
			// and emits them as real (if never-fetched) chunks — dead weight in the
			// deploy (dompurify alone is ~27KB). Externalizing drops all three from
			// the build entirely; if `.html()` is ever actually called, all three
			// would need to become real (non-external) dependencies again first, or
			// that call fails at runtime.
			external: ["html2canvas", "canvg", "dompurify"],
		},
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
			},
			// SPA: no server-rendering, no prerendering (see root +layout.ts) --
			// every route, including "/", is client-only, so the fallback shim
			// SvelteKit gives us for free is the *only* HTML file the build emits.
			// Naming it index.html (rather than the more common 200.html) matters:
			// @convex-dev/static-hosting's SPA fallback always serves /index.html
			// for a path it can't find, with no way to point it elsewhere -- see
			// convex/http.ts.
			adapter: adapter({ fallback: "index.html" }),
		}),
	],
	test: {
		expect: { requireAssertions: true },
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			// convex/ is included alongside src/lib: it holds every authorization check, state
			// transition and LLM-boundary path in the app and is covered by the `convex` project
			// below, but was previously absent from this list -- so CI reported coverage for the
			// frontend only and an uncovered backend branch was invisible.
			include: ["src/lib/**/*.{ts,svelte}", "convex/**/*.ts"],
			exclude: [
				// The Google Identity ambient declaration contains no behavior to cover.
				"src/lib/*.d.ts",
				// Generated code, test-only harnesses, and pure config/registration modules with
				// no branches of their own.
				"convex/_generated/**",
				"convex/test.setup.ts",
				"convex/testFactories.ts",
				"convex/convex.config.ts",
				"convex/auth.config.ts",
			],
		},
		projects: [
			{
				// Pure logic: prompt/graph/format helpers, and the student run store.
				// No DOM — these must keep working under SSR too.
				extends: "./vite.config.ts",
				test: {
					name: "server",
					environment: "node",
					include: ["tests/**/*.{test,spec}.{js,ts}"],
					// `*.dom.test.ts` and `*.svelte.test.ts` belong to the client
					// project below; without excluding them here they would run
					// twice, and fail in node for want of a document.
					exclude: [
						"tests/**/*.svelte.{test,spec}.{js,ts}",
						"tests/**/*.dom.{test,spec}.{js,ts}",
					],
					setupFiles: ["./tests/support/setup.node.ts"],
				},
			},
			{
				// Anything that needs a document: Svelte components, and the
				// DOMParser-based case importer.
				extends: "./vite.config.ts",
				// Without this, vitest resolves svelte's node/SSR export condition
				// even under jsdom, and mounting a real component throws
				// "mount(...) is not available on the server". Scoped to this
				// project so the actual build is untouched.
				resolve: { conditions: ["browser"] },
				test: {
					name: "client",
					environment: "jsdom",
					clearMocks: true,
					include: [
						"tests/**/*.svelte.{test,spec}.{js,ts}",
						"tests/**/*.dom.{test,spec}.{js,ts}",
					],
					setupFiles: ["./tests/support/setup.client.ts"],
				},
			},
			// Kept as its own config file (not `extends: "./vite.config.ts"` like the
			// two projects above) so convex/ tests run isolated from the SvelteKit/
			// Tailwind plugins -- they were never designed to run under convex-test's
			// edge-runtime environment.
			"./convex/vitest.config.ts",
		],
	},
});
