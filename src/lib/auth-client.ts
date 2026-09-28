import {
	convexClient,
	crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/svelte";
import { resolveConvexSiteUrl } from "./convexUrl.js";

export const authClient = createAuthClient({
	baseURL: resolveConvexSiteUrl(),
	plugins: [convexClient(), crossDomainClient()],
});
