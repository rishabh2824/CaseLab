import { PUBLIC_CONVEX_URL } from "$env/static/public";

// Returns the Convex deployment URL, from the PUBLIC_CONVEX_URL env var.
export function resolveConvexUrl(): string {
	return PUBLIC_CONVEX_URL;
}

// Returns the Convex HTTP (.convex.site) URL derived from the deployment URL.
export function resolveConvexSiteUrl(): string {
	return resolveConvexUrl().replace(/\.convex\.cloud$/, ".convex.site");
}
