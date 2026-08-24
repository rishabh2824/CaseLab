import { PUBLIC_CONVEX_URL } from "$env/static/public";

// `npx @convex-dev/static-hosting deploy` builds the frontend itself and injects
// VITE_CONVEX_URL from the *target* deployment's own CONVEX_CLOUD_URL (see its
// runFrontendBuild), so this is always correct for whichever deployment -- dev,
// prod, or prod behind a custom domain -- is actually being deployed to. A
// hostname-derived or hand-set PUBLIC_CONVEX_URL can't make that distinction:
// it's shared across every deployment and only matches whichever one happened
// to be configured locally, and it breaks entirely once prod is served from a
// custom domain instead of a `*.convex.site` origin. Falls back to
// PUBLIC_CONVEX_URL for local dev (`vite dev`), where the deploy CLI never runs.
export function resolveConvexUrl(): string {
	return import.meta.env.VITE_CONVEX_URL ?? PUBLIC_CONVEX_URL;
}
