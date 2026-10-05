import { PUBLIC_CONVEX_URL } from "$app/env/public";

export function resolveConvexUrl(): string {
	return import.meta.env.VITE_CONVEX_URL ?? PUBLIC_CONVEX_URL;
}

// Returns the Convex HTTP (.convex.site) URL derived from the deployment URL.
export function resolveConvexSiteUrl(): string {
	return resolveConvexUrl().replace(/\.convex\.cloud$/, ".convex.site");
}
