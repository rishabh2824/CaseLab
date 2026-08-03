<script lang="ts">
import type { Snippet } from "svelte";
import { goto } from "$app/navigation";
import { apiFetch } from "$lib/api/client.js";
import { session } from "$lib/session.svelte.js";
import type { Api } from "$lib/types.js";

// window.google is typed ambiently in $lib/google-identity.d.ts (Google
// Identity Services loads it at runtime — see loadGsiScript below; no
// @types package exists for it).

type Props = {
	class?: string;
	children?: Snippet;
};

let { class: className = "", children }: Props = $props();

const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

let error = $state("");
let isPending = $state(false);
let showPicker = $state(false);
let pickerContainer: HTMLDivElement | undefined = $state();
let initialized = false;
let gsiLoadPromise: Promise<void> | null = null;

// Deferred to first click (rather than onMount) so the GSI script isn't
// downloaded by every landing-page visitor — the vast majority are students
// who never touch this button.
function loadGsiScript(): Promise<void> {
	if (gsiLoadPromise) return gsiLoadPromise;
	gsiLoadPromise = new Promise((resolve, reject) => {
		const existing =
			document.querySelector<HTMLScriptElement>("script[data-gsi]");
		if (existing) {
			if (window.google?.accounts?.id) resolve();
			else existing.addEventListener("load", () => resolve());
			return;
		}
		const script = document.createElement("script");
		script.src = "https://accounts.google.com/gsi/client";
		script.async = true;
		script.dataset.gsi = "true";
		script.onload = () => resolve();
		script.onerror = () => reject(new Error("Failed to load Google sign-in"));
		document.head.appendChild(script);
	});
	return gsiLoadPromise;
}

async function login(credential: string): Promise<void> {
	isPending = true;
	try {
		const data = await apiFetch<Api<"LoginResponse">>("/api/admin/login", {
			method: "POST",
			body: { credential } satisfies Api<"LoginRequest">,
		});
		error = "";
		session.setAdmin({ adminRole: data.role, adminEmail: data.email });
		await goto("/admin");
	} catch (err) {
		error =
			(err instanceof Error && err.message) ||
			"Your account is not authorized. Ask a super admin to add you.";
	} finally {
		isPending = false;
	}
}

function handleCredentialResponse(response: GoogleCredentialResponse): void {
	showPicker = false;
	login(response.credential);
}

function ensureInitialized(): boolean {
	if (initialized) return true;
	const id = window.google?.accounts?.id;
	if (!id) return false;
	id.initialize({
		client_id: GOOGLE_CLIENT_ID,
		callback: handleCredentialResponse,
		use_fedcm_for_button: true,
	});
	initialized = true;
	return true;
}

// Renders Google's real button (full "Sign in with Google" button) into the
// popover every time it opens. This has to be Google's own element, not
// ours — a custom button can only trigger One Tap (accounts.id.prompt),
// which silently fails on Safari/Firefox since they don't support FedCM.
// renderButton's click falls back to a real popup on those browsers
// instead, so it's the only mechanism here that works across all of them.
$effect(() => {
	if (showPicker && pickerContainer) {
		window.google?.accounts?.id?.renderButton(pickerContainer, {
			type: "standard",
			size: "large",
			text: "signin_with",
			shape: "rectangular",
		});
	}
});

async function handleClick(): Promise<void> {
	error = "";
	if (showPicker) {
		showPicker = false;
		return;
	}
	if (!window.google?.accounts?.id) {
		isPending = true;
		try {
			await loadGsiScript();
		} catch {
			isPending = false;
			error = "Google sign-in is unavailable right now. Try again in a moment.";
			return;
		}
		isPending = false;
	}
	if (!ensureInitialized()) {
		error = "Google sign-in is unavailable right now. Try again in a moment.";
		return;
	}
	showPicker = true;
}
</script>

<div class="relative inline-block">
	<button type="button" onclick={handleClick} class={className}>
		{#if isPending}
			Signing in…
		{:else}
			{@render children?.()}
		{/if}
	</button>
	{#if showPicker}
		<div class="absolute right-0 top-full z-20 mt-2 rounded-lg border border-line bg-white p-2 shadow-md">
			<!-- Google's injected icon SVG has no width/height attrs and its own
			     stylesheet sizes it with a %, which can't resolve here (the
			     containing chain bottoms out in an auto-width box) — renders
			     as a blank square without this explicit fallback size. -->
			<div bind:this={pickerContainer} class="[&_svg]:size-5"></div>
		</div>
	{/if}
	{#if error}
		<p class="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium text-brand shadow-md">
			{error}
		</p>
	{/if}
</div>
