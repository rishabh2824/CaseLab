// Ambient types for the Google Identity Services (GSI) script loaded at
// runtime by SignInButton.svelte — https://accounts.google.com/gsi/client.
// No @types package exists for this; only the shape actually used is modeled.
// This file has no imports/exports, so it's a global (not module) script —
// `interface Window` below merges directly into lib.dom's Window.

interface GoogleCodeResponse {
	code: string
	error?: string
}

interface GoogleCodeClient {
	requestCode: () => void
}

interface GoogleCodeClientConfig {
	client_id: string
	scope: string
	ux_mode: 'popup' | 'redirect'
	callback: (response: GoogleCodeResponse) => void
}

interface Window {
	google?: {
		accounts?: {
			oauth2?: {
				initCodeClient: (config: GoogleCodeClientConfig) => GoogleCodeClient
			}
		}
	}
}
