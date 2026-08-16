import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "convex",
		environment: "edge-runtime",
		server: { deps: { inline: ["convex-test"] } },
	},
});
