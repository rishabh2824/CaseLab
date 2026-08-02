// Ambient types for the Google Identity Services (GSI) script loaded at
// runtime by SignInButton.svelte — https://accounts.google.com/gsi/client.
// No @types package exists for this; only the shape actually used is modeled.
// This file has no imports/exports, so it's a global (not module) script —
// `interface Window` below merges directly into lib.dom's Window.
//
// Uses `accounts.id`'s renderButton (Sign In With Google), not
// accounts.id.prompt (One Tap) or accounts.oauth2. One Tap only works via
// FedCM and fails silently on Safari/Firefox (no FedCM support there);
// renderButton falls back to a real popup on those browsers, so it's the
// only mechanism in this API that actually works everywhere.

interface GoogleCredentialResponse {
	/** The ID token as a base64url-encoded JWT string. */
	credential: string;
	select_by?: string;
}

interface GoogleIdConfiguration {
	client_id: string;
	callback: (response: GoogleCredentialResponse) => void;
	use_fedcm_for_button: boolean;
}

interface GoogleButtonConfiguration {
	type: "standard" | "icon";
	size?: "large" | "medium" | "small";
	theme?: "outline" | "filled_blue" | "filled_black" | "outline_dark";
	text?: "signin_with" | "signup_with" | "continue_with" | "signin";
	shape?: "rectangular" | "pill" | "circle" | "square";
	logo_alignment?: "left" | "center";
	width?: string;
}

interface Window {
	google?: {
		accounts?: {
			id?: {
				initialize: (config: GoogleIdConfiguration) => void;
				renderButton: (
					parent: HTMLElement,
					options: GoogleButtonConfiguration,
				) => void;
			};
		};
	};
}
