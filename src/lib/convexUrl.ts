import { getConvexUrl } from "@convex-dev/static-hosting";
import { PUBLIC_CONVEX_URL } from "$env/static/public";

// The static build gets uploaded to every Convex deployment (dev, prod, ...) via the
// same `npm run build`, so a build-time-baked PUBLIC_CONVEX_URL would point every
// deployment's frontend at whichever backend happened to be configured locally when
// that build ran -- silently wrong on every deployment except the one that matches.
// When served from Convex's own static hosting (a `*.convex.site` origin), derive the
// backend URL from the page's own hostname instead. Falls back to PUBLIC_CONVEX_URL for
// local dev (`vite dev` on localhost), where there's no `.convex.site` origin to derive from.
export function resolveConvexUrl(): string {
	if (
		typeof window !== "undefined" &&
		window.location.hostname.endsWith(".convex.site")
	) {
		return getConvexUrl();
	}
	return PUBLIC_CONVEX_URL;
}
