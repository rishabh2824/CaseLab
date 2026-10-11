import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// The live end-to-end build must not overwrite build/, the folder that gets deployed.
const buildDir = process.env.BUILD_DIR ?? "build";

export default defineConfig({
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
			adapter: adapter({
				pages: buildDir,
				assets: buildDir,
				fallback: "index.html",
			}),
		}),
	],
	test: {
		expect: { requireAssertions: true },
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			include: [
				"src/lib/**/*.{ts,svelte}",
				"src/routes/**/*.svelte",
				"convex/**/*.ts",
			],
			exclude: [
				"src/lib/*.d.ts",
				"convex/_generated/**",
				"convex/test.setup.ts",
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
