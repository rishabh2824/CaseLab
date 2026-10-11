import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "convex",
		environment: "edge-runtime",
		setupFiles: ["./vitest.setup.ts"],
		server: { deps: { inline: ["convex-test"] } },
	},
});
