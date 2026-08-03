import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
			},
			// SPA: no server-rendering (see root +layout.js), static-hosted, client
			// routing needs the same fallback shim SvelteKit gives us for free.
			adapter: adapter({ fallback: "200.html" }),
		}),
	],
	server: {
		// Proxy API calls to the backend so the browser sees frontend and backend
		// as the same origin locally too, matching production's path-based routing
		// under one domain (see backend/services/admin_auth.py's admin_session
		// cookie, which is SameSite=Lax and gets silently rejected by the browser
		// without this — it relies on first-party/same-origin, not cross-site CORS).
		proxy: {
			"/api": {
				target: "http://127.0.0.1:8000",
				changeOrigin: true,
				ws: true,
			},
		},
	},
	test: {
		expect: { requireAssertions: true },
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/lib/**/*.{ts,svelte}"],
			// Generated wire types, the Google Identity ambient declaration, and
			// the barrel file contain no behavior to cover.
			exclude: [
				"src/lib/api/schema.d.ts",
				"src/lib/*.d.ts",
				"src/lib/index.ts",
			],
		},
		projects: [
			{
				// Pure logic: prompt/graph/format helpers, the API client, and the
				// student run store. No DOM — these must keep working under SSR too.
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
		],
	},
});
