interface GoogleCredentialResponse {
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
