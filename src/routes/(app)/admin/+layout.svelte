<script lang="ts">
import {
	createSvelteAuthClient,
	useAuth,
} from "@mmailaender/convex-better-auth-svelte/svelte";
import { getConvexClient, useQuery } from "convex-svelte";
import type { Snippet } from "svelte";
import { setViewerContext } from "#lib/adminViewer.js";
import { authClient } from "#lib/auth-client.js";
import AdminTopBar from "#lib/components/AdminTopBar.svelte";
import { getErrorMessage } from "#lib/errors.js";
import { goto } from "$app/navigation";
import { api } from "../../../../convex/_generated/api.js";

type Props = { children: Snippet };
let { children }: Props = $props();

createSvelteAuthClient({ authClient, convexClient: getConvexClient() });

const auth = useAuth();
const viewer = useQuery(api.admins.viewer, {});
setViewerContext(viewer);

const OTT_EXCHANGE_GRACE_MS = 4000;
const hasOttParam = new URLSearchParams(window.location.search).has("ott");
let awaitingOttExchange = $state(hasOttParam);
if (hasOttParam) {
	setTimeout(() => {
		awaitingOttExchange = false;
	}, OTT_EXCHANGE_GRACE_MS);
}

const authErrorParam = new URLSearchParams(window.location.search).get("error");

let signInError = $state("");

let signInTriggered = false;
// Starts the Google sign-in flow, recording any error to show.
function startGoogleSignIn(): void {
	signInTriggered = true;
	signInError = "";
	authClient.signIn
		.social({
			provider: "google",
			callbackURL: "/admin",
			errorCallbackURL: "/admin?error=unauthorized",
		})
		.catch((err) => {
			signInError =
				err instanceof Error ? err.message : "Sign-in failed. Try again.";
		});
}

$effect(() => {
	if (
		auth.isLoading ||
		signInTriggered ||
		auth.isAuthenticated ||
		awaitingOttExchange ||
		authErrorParam === "unauthorized"
	) {
		return;
	}
	startGoogleSignIn();
});

// Retries Google sign-in after a failure.
function retrySignIn(): void {
	signInTriggered = false;
	startGoogleSignIn();
}

// Signs out a non-authorized user and returns to the landing page.
async function signOutNotAuthorized(): Promise<void> {
	authClient.signOut().catch(() => {});
	await goto("/");
}
</script>

{#if authErrorParam === "unauthorized"}
	<div class="flex h-screen flex-col items-center justify-center gap-3">
		<p class="text-sm font-medium text-brand">Your account is not authorized.</p>
		<a href="/" class="text-sm underline">Back to the landing page</a>
	</div>
{:else if signInError}
	<div class="flex h-screen flex-col items-center justify-center gap-3">
		<p class="text-sm font-medium text-brand">{signInError}</p>
		<button type="button" onclick={retrySignIn} class="text-sm underline">
			Try again
		</button>
	</div>
{:else if auth.isAuthenticated && !auth.isLoading && !viewer.isLoading}
	{#if viewer.error}
		<div class="flex h-screen flex-col items-center justify-center gap-3">
			<p class="text-sm font-medium text-brand">
				{getErrorMessage(viewer.error, "Something went wrong loading your admin account.")}
			</p>
			<button type="button" onclick={() => location.reload()} class="text-sm underline">
				Reload
			</button>
		</div>
	{:else if !viewer.data}
		<div class="flex h-screen flex-col items-center justify-center gap-3">
			<p class="text-sm font-medium text-brand">Not authorized.</p>
			<button type="button" onclick={signOutNotAuthorized} class="text-sm underline">
				Sign out
			</button>
		</div>
	{:else}
		<AdminTopBar />
		{@render children()}
	{/if}
{/if}
