import type { UseQueryReturn } from "convex-svelte";
import { getContext, setContext } from "svelte";
import type { api } from "../../convex/_generated/api.js";

type ViewerQuery = UseQueryReturn<typeof api.api.admins.viewer>;

export const VIEWER_CONTEXT_KEY = Symbol("admin-viewer");

// Shares the admin viewer query with descendant components via Svelte context.
export function setViewerContext(viewer: ViewerQuery): void {
	setContext(VIEWER_CONTEXT_KEY, viewer);
}

// Reads the shared admin viewer query from Svelte context.
export function getViewerContext(): ViewerQuery {
	return getContext(VIEWER_CONTEXT_KEY);
}
