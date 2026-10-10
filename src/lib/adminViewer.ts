import type { UseQueryReturn } from "convex-svelte";
import { createContext } from "svelte";
import type { api } from "../../convex/_generated/api.js";

type ViewerQuery = UseQueryReturn<typeof api.admins.viewer>;

// Shares the admin viewer query with descendant components via Svelte context.
export const [getViewerContext, setViewerContext] =
	createContext<ViewerQuery>();
