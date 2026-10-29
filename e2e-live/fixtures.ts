import { test as base, expect, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { LiveEnv } from "./global-setup.js";
import type { Role } from "./harness/seed.js";

export { api, expect };

// Reads what global setup published for the workers.
function liveEnv(): LiveEnv {
	const raw = process.env.E2E_LIVE;
	if (!raw) throw new Error("E2E_LIVE is not set; did global setup run?");
	return JSON.parse(raw) as LiveEnv;
}

// Returns a letters-only access code that no other test uses.
export function uniqueCode(): string {
	const letters = Array.from({ length: 10 }, () =>
		String.fromCharCode(97 + Math.floor(Math.random() * 26)),
	).join("");
	return `live${letters}`;
}

type LiveFixtures = {
	// A client for the real Convex API, signed in as the given role.
	apiAs: (role: Role) => Promise<ConvexHttpClient>;
	// Signs the browser in as the given role without going through Google.
	signInAs: (page: Page, role: Role) => Promise<void>;
	// Creates a one-persona case through the real API and returns its access code and id.
	seedCase: (options?: {
		role?: Role;
		name?: string;
		personaName?: string;
		extraPersonas?: { id: string; name: string; role: string }[];
		referrals?: { fromId: string; toId: string; conditions: string }[];
	}) => Promise<{ accessCode: string; caseId: string; name: string }>;
};

export const test = base.extend<LiveFixtures>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern, even for a fixture with no dependencies
	apiAs: async ({}, use) => {
		const env = liveEnv();
		await use(async (role) => {
			const response = await fetch(`${env.siteUrl}/api/auth/convex/token`, {
				headers: { cookie: `better-auth.session_token=${env.cookies[role]}` },
			});
			const { token } = (await response.json()) as { token: string };
			const client = new ConvexHttpClient(env.cloudUrl);
			client.setAuth(token);
			return client;
		});
	},

	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern, even for a fixture with no dependencies
	signInAs: async ({}, use) => {
		const env = liveEnv();
		await use(async (page, role) => {
			const stored = JSON.stringify({
				"better-auth.session_token": {
					value: env.cookies[role],
					expires: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
				},
			});
			await page.addInitScript((value) => {
				localStorage.setItem("better-auth_cookie", value);
			}, stored);
		});
	},

	seedCase: async ({ apiAs }, use) => {
		await use(async (options = {}) => {
			const client = await apiAs(options.role ?? "super");
			const accessCode = uniqueCode();
			const name = options.name ?? `Case ${accessCode}`;
			const persona = (id: string, personaName: string, role: string) => ({
				id,
				name: personaName,
				role,
				profilePhoto: null,
				knownFacts: "The vendor is Acme Supplies.",
				personalityTraits: "",
				availabilityMinutes: null,
				files: [],
			});
			const { caseId } = await client.mutation(api.cases.create, {
				name,
				brief: "Reduce office supply costs.",
				commonInformation: "",
				accessCode,
				structure: {
					personas: [
						persona("A", options.personaName ?? "Mary", "CFO"),
						...(options.extraPersonas ?? []).map((p) =>
							persona(p.id, p.name, p.role),
						),
					],
					referrals: options.referrals ?? [],
					roots: ["A"],
				},
				collaborators: [],
			});
			return { accessCode, caseId, name };
		});
	},
});
