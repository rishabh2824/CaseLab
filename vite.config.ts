import path from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

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
		include: [
			"convex-svelte",
			"@mmailaender/convex-better-auth-svelte/svelte",
			"better-auth/svelte",
			"@convex-dev/better-auth/client/plugins",
			"convex/server",
			"convex/browser",
		],
	},
	build: {
		rollupOptions: {
			external: ["html2canvas", "canvg", "dompurify"],
		},
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
			},
			adapter: adapter({ fallback: "index.html" }),
		}),
	],
	test: {
		expect: { requireAssertions: true },
		onUnhandledError: (error) => !error.message?.startsWith("Turn failed:"),
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: ["src/lib/**/*.{ts,svelte}", "convex/**/*.ts"],
			exclude: [
				"src/lib/*.d.ts",
				"convex/_generated/**",
				"convex/test.setup.ts",
				"convex/testFactories.ts",
				"convex/convex.config.ts",
				"convex/auth.config.ts",
			],
		},
		projects: [
			{
				extends: "./vite.config.ts",
				test: {
					name: "server",
					environment: "node",
					include: ["tests/**/*.{test,spec}.{js,ts}"],
					exclude: [
						"tests/**/*.svelte.{test,spec}.{js,ts}",
						"tests/**/*.dom.{test,spec}.{js,ts}",
					],
					setupFiles: ["./tests/support/setup.node.ts"],
				},
			},
			{
				extends: "./vite.config.ts",
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
			"./convex/vitest.config.ts",
		],
	},
});
