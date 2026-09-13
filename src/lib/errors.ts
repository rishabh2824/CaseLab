import { ConvexError } from "convex/values";

// The one place that knows how to pull a user-showable message out of a caught Convex error.
// A `throw new ConvexError("...")` mutation/query rejection reaches the client as a
// `ConvexError` whose `.data` is exactly that string -- but its `.message` is
// `createHybridErrorStacktrace`'s own wrapper (`[CONVEX M(api/x:y)] [Request ID: ...] <msg>
// Called by client`), the same noisy text a user isn't supposed to see, so `.data` is checked
// first and preferred. A handler that still throws a plain `Error` falls through to
// `.message` -- unredacted in dev, but replaced with a generic "Server Error" in production
// (Convex's own redaction, not this function's doing). That redacted wrapper still starts with
// the same `[CONVEX ` prefix (it's the same createHybridErrorStacktrace wrapping, just around
// "Server Error" instead of the real message), so it's just as unfit to show an admin as the
// unredacted one is -- both are rejected here, falling through to `fallback` instead.
export function getErrorMessage(err: unknown, fallback: string): string {
	if (err instanceof ConvexError && typeof err.data === "string" && err.data) {
		return err.data;
	}
	if (
		err instanceof Error &&
		err.message &&
		!err.message.startsWith("[CONVEX ")
	) {
		return err.message;
	}
	return fallback;
}
