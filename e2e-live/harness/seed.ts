import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { convexCliOrThrow } from "./backend.js";

// Seeds the local backend: the admin roster, and a Better Auth user and session for each role, so a
// test can sign in without Google by putting the session cookie into the browser's storage.

export const AUTH_SECRET = "local-e2e-secret-0123456789abcdef0123456789";

export type Role = "super" | "admin" | "stranger";

const USERS: Record<Role, { email: string; name: string; onRoster: boolean }> =
	{
		super: {
			email: "super@e2e.caselab.invalid",
			name: "Super E2E",
			onRoster: true,
		},
		admin: {
			email: "admin@e2e.caselab.invalid",
			name: "Admin E2E",
			onRoster: true,
		},
		stranger: {
			email: "stranger@e2e.caselab.invalid",
			name: "Stranger E2E",
			onRoster: false,
		},
	};

const SCRATCH = path.join(process.cwd(), "e2e-live", ".tmp");

// Writes a JSONL file into the scratch folder and returns its path.
function writeJsonl(name: string, rows: object[]): string {
	mkdirSync(SCRATCH, { recursive: true });
	const file = path.join(SCRATCH, name);
	writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
	return file;
}

// Replaces a table's contents with the given rows (none empties it).
async function replaceTable(
	table: string,
	rows: object[],
	component?: string,
): Promise<void> {
	const file = writeJsonl(`${component ?? "app"}-${table}.jsonl`, rows);
	const args = ["import", "--table", table, "--replace", "-y"];
	if (component) args.push("--component", component);
	await convexCliOrThrow([...args, file]);
}

// Extracts the JSON document a `convex run` printed.
function parseRunOutput(output: string): { _id: string } {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	return JSON.parse(output.slice(start, end + 1));
}

// Builds the signed session cookie value Better Auth expects for a session token.
function signedCookie(token: string): string {
	const signature = createHmac("sha256", AUTH_SECRET)
		.update(token)
		.digest("base64");
	return `${token}.${encodeURIComponent(signature)}`;
}

// Calls the Better Auth component's adapter to create a row.
async function createAuthRow(
	model: string,
	data: Record<string, unknown>,
): Promise<{ _id: string }> {
	const output = await convexCliOrThrow([
		"run",
		"--component",
		"betterAuth",
		"adapter:create",
		JSON.stringify({ input: { model, data } }),
	]);
	return parseRunOutput(output);
}

// Empties the app's tables and creates the roster, users and sessions; returns each role's session cookie.
export async function seedBackend(): Promise<Record<Role, string>> {
	for (const table of [
		"cases",
		"runs",
		"runMessages",
		"collaborators",
		"caseFiles",
	]) {
		await replaceTable(table, []);
	}
	await replaceTable(
		"admins",
		(["super", "admin"] as const).map((role) => ({
			email: USERS[role].email,
			name: USERS[role].name,
			role,
		})),
	);
	for (const table of ["user", "session", "account", "verification"]) {
		await replaceTable(table, [], "betterAuth");
	}

	const now = Date.now();
	const cookies = {} as Record<Role, string>;
	await Promise.all(
		(Object.keys(USERS) as Role[]).map(async (role) => {
			const user = await createAuthRow("user", {
				name: USERS[role].name,
				email: USERS[role].email,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			});
			const token = `e2e-session-${role}`;
			await createAuthRow("session", {
				token,
				userId: user._id,
				createdAt: now,
				updatedAt: now,
				expiresAt: now + 24 * 60 * 60 * 1000,
			});
			cookies[role] = signedCookie(token);
		}),
	);
	return cookies;
}
