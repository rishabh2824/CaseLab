import type { GenericCtx } from "@convex-dev/better-auth";
import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { createAuth } from "./auth";
import { newTestConvex } from "./test.setup";

type NewUser = { email?: string; name?: string | null };

// Runs the sign-in hook Better Auth calls before it creates a user.
async function runBeforeCreate(
	t: ReturnType<typeof newTestConvex>,
	user: NewUser,
) {
	return t.run(async (ctx) => {
		const auth = createAuth(ctx as unknown as GenericCtx<DataModel>);
		const hook = auth.options.databaseHooks?.user?.create?.before;
		return hook?.(user as never);
	});
}

// Runs the hook and returns the API error it throws, or null if it allows the user.
async function rejection(t: ReturnType<typeof newTestConvex>, user: NewUser) {
	try {
		await runBeforeCreate(t, user);
	} catch (err) {
		return err as APIError;
	}
	return null;
}

describe("adminForSignIn", () => {
	// Tests that the lookup ignores casing and padding and returns null for an unknown email.
	it("finds a rostered admin case-insensitively and returns null for a stranger", async () => {
		const t = newTestConvex();
		await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: "a@test.caselab.invalid",
				role: "admin",
			}),
		);
		const found = await t.query(internal.auth.adminForSignIn, {
			email: "  A@Test.Caselab.Invalid ",
		});
		expect(found?.email).toBe("a@test.caselab.invalid");
		expect(
			await t.query(internal.auth.adminForSignIn, {
				email: "nobody@test.caselab.invalid",
			}),
		).toBeNull();
	});
});

describe("sign-in authorization hook", () => {
	// Tests that a Google account with no email is refused before any lookup.
	it("rejects an account with no email as a bad request", async () => {
		const t = newTestConvex();
		const err = await rejection(t, { name: "No Email" });
		expect(err).toBeInstanceOf(APIError);
		expect(err?.status).toBe("BAD_REQUEST");
		expect(err?.message).toBe("Google account has no email.");
	});

	// Tests that an account whose email is not on the admin roster is refused.
	it("rejects an account that is not on the admin roster as unauthorized", async () => {
		const t = newTestConvex();
		const err = await rejection(t, { email: "stranger@test.caselab.invalid" });
		expect(err).toBeInstanceOf(APIError);
		expect(err?.status).toBe("UNAUTHORIZED");
		expect(err?.message).toBe("Your account is not authorized.");
	});

	// Tests that a rostered admin is allowed and keeps the name Google supplied.
	it("allows a rostered admin and keeps the Google name", async () => {
		const t = newTestConvex();
		await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: "a@test.caselab.invalid",
				name: "Roster Name",
				role: "admin",
			}),
		);
		const result = await runBeforeCreate(t, {
			email: "a@test.caselab.invalid",
			name: "Google Name",
		});
		expect(result).toEqual({
			data: { email: "a@test.caselab.invalid", name: "Google Name" },
		});
	});

	// Tests that a missing Google name falls back to the roster name.
	it("falls back to the roster name when Google supplies none", async () => {
		const t = newTestConvex();
		await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: "a@test.caselab.invalid",
				name: "Roster Name",
				role: "admin",
			}),
		);
		const result = await runBeforeCreate(t, {
			email: "a@test.caselab.invalid",
		});
		expect(result).toMatchObject({ data: { name: "Roster Name" } });
	});

	// Tests that the roster lookup ignores email casing so sign-in matches how admins are stored.
	it("matches the roster regardless of the email's casing", async () => {
		const t = newTestConvex();
		await t.run((ctx) =>
			ctx.db.insert("admins", {
				email: "a@test.caselab.invalid",
				role: "admin",
			}),
		);
		expect(await rejection(t, { email: "A@TEST.caselab.invalid" })).toBeNull();
	});
});
