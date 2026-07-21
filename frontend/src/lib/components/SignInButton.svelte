<script lang="ts">
	import { onMount, type Snippet } from 'svelte'
	import { goto } from '$app/navigation'
	import { apiFetch } from '$lib/api/client.js'
	import { session } from '$lib/session.svelte.js'
	import type { LoginRequest, LoginResponse } from '$lib/types.js'

	// window.google is typed ambiently in $lib/google-identity.d.ts (Google
	// Identity Services loads it at runtime — see onMount below; no @types
	// package exists for it).

	type Props = {
		class?: string
		children?: Snippet
	}

	let { class: className = '', children }: Props = $props()

	const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

	let error = $state('')
	let isPending = $state(false)
	let codeClient: GoogleCodeClient | null = null

	// Loaded here (rather than a static <script> in app.html) so the GSI
	// client only ever loads on a page that actually renders this button —
	// student/admin routes don't pay for it.
	onMount(() => {
		if (document.querySelector('script[data-gsi]')) return
		const script = document.createElement('script')
		script.src = 'https://accounts.google.com/gsi/client'
		script.async = true
		script.defer = true
		script.dataset.gsi = 'true'
		document.head.appendChild(script)
	})

	async function login(googleAuthCode: string): Promise<void> {
		isPending = true
		try {
			const data = await apiFetch<LoginResponse>('/api/admin/login', {
				method: 'POST',
				body: { google_auth_code: googleAuthCode } satisfies LoginRequest,
			})
			error = ''
			session.setAdmin({ adminRole: data.role, adminEmail: data.email })
			await goto('/admin')
		} catch (err) {
			error = (err instanceof Error && err.message) || 'Your account is not authorized. Ask a super admin to add you.'
		} finally {
			isPending = false
		}
	}

	function handleCodeResponse(response: GoogleCodeResponse): void {
		if (response.error) {
			// 'popup_closed' fires when the admin just closes the picker
			// without choosing an account — not a real error.
			if (response.error !== 'popup_closed') {
				error = 'Google sign-in did not complete.'
			}
			return
		}
		login(response.code)
	}

	function ensureCodeClient(): GoogleCodeClient | null {
		const oauth2 = window.google?.accounts?.oauth2
		if (!oauth2) return null
		if (!codeClient) {
			codeClient = oauth2.initCodeClient({
				client_id: GOOGLE_CLIENT_ID,
				scope: 'openid email profile',
				ux_mode: 'popup',
				callback: handleCodeResponse,
			})
		}
		return codeClient
	}

	function handleClick() {
		error = ''
		const client = ensureCodeClient()
		if (!client) {
			error = 'Google sign-in is still loading. Try again in a moment.'
			return
		}
		client.requestCode()
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
	{#if error}
		<p class="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium text-brand shadow-md">
			{error}
		</p>
	{/if}
</div>
