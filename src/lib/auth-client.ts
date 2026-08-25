import {
	convexClient,
	crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/svelte";
import { resolveConvexSiteUrl } from "./convexUrl.js";

// baseURL is Convex's own site URL, matching convex/auth.ts's server-side baseURL --
// the browser talks to Convex directly rather than through a SvelteKit server proxy (see
// convex/auth.ts for why), bridged cross-origin by crossDomainClient's one-time-token
// exchange.
export const authClient = createAuthClient({
	baseURL: resolveConvexSiteUrl(),
	plugins: [convexClient(), crossDomainClient()],
});
