/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiter from "@convex-dev/rate-limiter/test";
import schema from "./schema";

// Called from every *.test.ts file to get a fresh in-memory backend. Lives at the convex/
// root (not in a test-only subfolder) so `import.meta.glob` below sees every real module --
// convex-test needs the full module map to resolve `internal.*`/`api.*` references made by
// actions and scheduled functions.
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);

export function newTestConvex() {
	const t = convexTest(schema, modules);
	// lib/rateLimits.ts calls into the rateLimiter component (registered in convex.config.ts)
	// on every startSimulation/startTurn call -- convex-test has no way to discover a
	// component's own schema/functions on its own, so the component's own test helper
	// registers them the same way a real deployment's build step would.
	rateLimiter.register(t);
	return t;
}

// A signed-in admin's `t` handle plus the ids convex-test needs to look them up again.
export async function withAdmin(
	t: ReturnType<typeof newTestConvex>,
	overrides: { email?: string; name?: string; role?: "super" | "admin" } = {},
) {
	const email = overrides.email ?? `admin-${Math.random().toString(36).slice(2)}@test.caselab.invalid`;
	const adminId = await t.run(async (ctx) =>
		ctx.db.insert("admins", { email, name: overrides.name, role: overrides.role ?? "admin" }),
	);
	const userId = await t.run(async (ctx) => ctx.db.insert("users", { email, name: overrides.name }));
	return { adminId, userId, email, asUser: t.withIdentity({ subject: userId }) };
}
