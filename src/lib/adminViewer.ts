// The signed-in admin's api/admins:viewer query, shared via Svelte context instead of each
// of admin/+layout.svelte, admin/+page.svelte, admin/admins/+page.svelte, and CaseForm.svelte
// independently calling useQuery(api.api.admins.viewer, {}) for the same data. Convex already
// dedupes identical query+arg subscriptions, so this was never a second network round trip --
// but it was four separate places importing the query, none of which need their own
// subscription when admin/+layout.svelte (the one component every admin route mounts inside)
// already holds one live for the whole subtree.
//
// setViewerContext must be called during a component's own initialization (Svelte context
// rules), which admin/+layout.svelte satisfies by calling it right after creating the query,
// unconditionally -- the query object itself is what's shared, not a snapshot of its `.data`,
// so every consumer's own $derived reads of `.data`/`.isLoading` stay reactive.

import type { UseQueryReturn } from "convex-svelte";
import { getContext, setContext } from "svelte";
import type { api } from "../../convex/_generated/api.js";

type ViewerQuery = UseQueryReturn<typeof api.api.admins.viewer>;

// Exported so tests can render a component tree with this context pre-seeded (Svelte context
// can only be set from inside a component's own initialization -- setViewerContext can't be
// called from plain test code -- so a test instead builds a `Map` keyed on this symbol and
// passes it straight to `render`/`mount`'s own `context` option).
export const VIEWER_CONTEXT_KEY = Symbol("admin-viewer");

export function setViewerContext(viewer: ViewerQuery): void {
	setContext(VIEWER_CONTEXT_KEY, viewer);
}

// Every caller of this is a descendant of admin/+layout.svelte (the only place that sets this
// context), which never renders its children until the viewer query has already resolved --
// so there's no "context not set yet" case to guard against here.
export function getViewerContext(): ViewerQuery {
	return getContext(VIEWER_CONTEXT_KEY);
}
