import { PUBLIC_CONVEX_URL } from "$env/static/public";

// Returns the Convex deployment URL, preferring a VITE_CONVEX_URL override.
export function resolveConvexUrl(): string {
	return import.meta.env.VITE_CONVEX_URL ?? PUBLIC_CONVEX_URL;
}

// Returns the Convex HTTP (.convex.site) URL derived from the deployment URL.
export function resolveConvexSiteUrl(): string {
	return resolveConvexUrl().replace(/\.convex\.cloud$/, ".convex.site");
}
