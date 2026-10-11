import { spawn } from "node:child_process";
import path from "node:path";
import { CLOUD_URL, SITE_URL, startLocalBackend } from "./harness/backend.js";
import { LLM_STUB_PORT, startLlmStub } from "./harness/llmStub.js";
import { AUTH_SECRET, type Role, seedBackend } from "./harness/seed.js";
import { APP_PORT, startStaticServer } from "./harness/staticServer.js";

export const BUILD_DIR = "build-e2e-live";

export type LiveEnv = {
	appUrl: string;
	cloudUrl: string;
	siteUrl: string;
	cookies: Record<Role, string>;
};

// Builds the frontend against the local backend.
function buildFrontend(): Promise<void> {
	return new Promise((resolve, reject) => {
		const vite = path.join(
			process.cwd(),
			"node_modules",
			"vite",
			"bin",
			"vite.js",
		);
		const child = spawn(process.execPath, [vite, "build"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				BUILD_DIR,
				PUBLIC_CONVEX_URL: CLOUD_URL,
				VITE_CONVEX_URL: CLOUD_URL,
				VITE_CONVEX_SITE_URL: SITE_URL,
			},
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.on("close", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`Frontend build failed:\n${output}`)),
		);
	});
}

// Starts everything the live suite needs: the LLM stand-in, a local Convex backend with seeded data,
// the built frontend and a static server for it. The returned function stops it all.
export default async function globalSetup(): Promise<() => Promise<void>> {
	const stops: (() => Promise<void>)[] = [];
	const stopAll = async () => {
		for (const stop of stops.reverse()) await stop().catch(() => {});
	};
	try {
		stops.push(await startLlmStub());
		const backend = await startLocalBackend({
			LLM_KEY: "e2e-key",
			LLM_BASE_URL: `http://127.0.0.1:${LLM_STUB_PORT}/v1`,
			SITE_URL: `http://localhost:${APP_PORT}`,
			BETTER_AUTH_SECRET: AUTH_SECRET,
			GOOGLE_CLIENT_ID: "e2e",
			GOOGLE_CLIENT_SECRET: "e2e",
		});
		stops.push(backend.stop);
		const cookies = await seedBackend();
		await buildFrontend();
		stops.push(await startStaticServer(BUILD_DIR));

		const env: LiveEnv = {
			appUrl: `http://localhost:${APP_PORT}`,
			cloudUrl: CLOUD_URL,
			siteUrl: SITE_URL,
			cookies,
		};
		process.env.E2E_LIVE = JSON.stringify(env);
	} catch (error) {
		await stopAll();
		throw error;
	}
	return stopAll;
}
