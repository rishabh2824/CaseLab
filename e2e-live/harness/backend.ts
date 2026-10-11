import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Starts and stops the local Convex backend the live end-to-end suite runs against.
// The Convex CLI rewrites the project's .env.local whenever it selects a deployment, so the file is
// backed up first and put back on teardown (or on the next run, if a previous run was killed).

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, ".env.local");
const ENV_BACKUP = path.join(ROOT, "e2e-live", ".env.local.bak");
const CONVEX_BIN = path.join(ROOT, "node_modules", "convex", "bin", "main.js");

export const CLOUD_URL = "http://127.0.0.1:3210";
export const SITE_URL = "http://127.0.0.1:3211";

type CliResult = { code: number; output: string };

// Runs the Convex CLI against the local deployment and returns its combined output.
export function convexCli(args: string[]): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CONVEX_BIN, ...args], {
			cwd: ROOT,
			env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.on("close", (code) => resolve({ code: code ?? 1, output }));
	});
}

// Runs a CLI command, retrying a couple of times, and throws with its output when it keeps failing.
export async function convexCliOrThrow(
	args: string[],
	retries = 2,
): Promise<string> {
	let last: CliResult = { code: 1, output: "" };
	for (let attempt = 0; attempt <= retries; attempt++) {
		last = await convexCli(args);
		if (last.code === 0) return last.output;
	}
	throw new Error(`convex ${args.join(" ")} failed:\n${last.output}`);
}

// Restores .env.local from a backup left behind by a run that did not clean up.
function restoreEnvFile(): void {
	if (!existsSync(ENV_BACKUP)) return;
	renameSync(ENV_BACKUP, ENV_FILE);
}

// Makes sure a local deployment exists and is the selected one.
async function selectLocalDeployment(): Promise<void> {
	let selected = await convexCli(["deployment", "select", "local"]);
	if (selected.output.includes("No local deployment found")) {
		await convexCliOrThrow(["deployment", "create", "local"]);
		selected = await convexCli(["deployment", "select", "local"]);
	}
	if (selected.code !== 0) {
		throw new Error(`Could not select a local deployment:\n${selected.output}`);
	}
}

// Kills a process and everything it spawned.
function killTree(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.pid === undefined || child.exitCode !== null) return resolve();
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]).on(
				"close",
				() => resolve(),
			);
		} else {
			child.once("close", () => resolve());
			child.kill("SIGTERM");
		}
	});
}

export type LocalBackend = { stop: () => Promise<void> };

// Starts `convex dev` against a local deployment, waits until its functions are deployed and sets the given env vars.
export async function startLocalBackend(
	envVars: Record<string, string>,
): Promise<LocalBackend> {
	restoreEnvFile();
	if (existsSync(ENV_FILE)) writeFileSync(ENV_BACKUP, readFileSync(ENV_FILE));

	const stop = async (child?: ChildProcess) => {
		if (child) await killTree(child);
		restoreEnvFile();
	};

	let dev: ChildProcess | undefined;
	try {
		await selectLocalDeployment();
		const started = spawn(
			process.execPath,
			[
				CONVEX_BIN,
				"dev",
				"--typecheck",
				"disable",
				"--codegen",
				"disable",
				"--tail-logs",
				"disable",
			],
			{ cwd: ROOT, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } },
		);
		dev = started;
		let log = "";
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`convex dev did not become ready:\n${log}`)),
				180_000,
			);
			const onData = (chunk: Buffer) => {
				log += chunk;
				if (log.includes("Convex functions ready")) {
					clearTimeout(timer);
					resolve();
				}
			};
			started.stdout.on("data", onData);
			started.stderr.on("data", onData);
			started.on("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`convex dev exited (${code}):\n${log}`));
			});
		});
		for (const [key, value] of Object.entries(envVars)) {
			await convexCliOrThrow(["env", "set", key, value]);
		}
		return { stop: () => stop(started) };
	} catch (error) {
		await stop(dev);
		throw error;
	}
}
