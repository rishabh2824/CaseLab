import { onMount } from "svelte";
import { beforeNavigate, goto } from "$app/navigation";

type SaveResult = { ok: true } | { ok: false; error: string };

// Holds navigation away from a form with unsaved changes behind a dialog. Construct it while a component is being set up.
export class LeaveGuard {
	// The navigation held behind the dialog, set while the dialog is open.
	pending = $state<(() => void) | null>(null);
	error = $state("");
	saving = $state(false);

	#allowed = false;
	#isDirty: () => boolean;
	#save: () => Promise<SaveResult>;

	constructor(isDirty: () => boolean, save: () => Promise<SaveResult>) {
		this.#isDirty = isDirty;
		this.#save = save;

		beforeNavigate((navigation) => {
			if (this.#allowed || !this.#isDirty()) return;
			const targetUrl = navigation.to?.url;
			if (!targetUrl) return;
			navigation.cancel();
			this.error = "";
			this.pending =
				navigation.type === "popstate" && navigation.delta !== undefined
					? () => history.go(navigation.delta)
					: () => goto(targetUrl);
		});

		onMount(() => {
			const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
				if (this.#allowed || !this.#isDirty()) return;
				event.preventDefault();
				event.returnValue = "";
			};
			window.addEventListener("beforeunload", handleBeforeUnload);
			return () =>
				window.removeEventListener("beforeunload", handleBeforeUnload);
		});
	}

	// Dismisses the dialog and stays on the page.
	stay(): void {
		this.pending = null;
		this.error = "";
	}

	// Continues the held navigation, without further prompts.
	leave(): void {
		const resume = this.pending;
		this.#allowed = true;
		this.stay();
		resume?.();
	}

	// Saves the form, then continues the held navigation if the save worked.
	async saveAndLeave(): Promise<void> {
		this.saving = true;
		this.error = "";
		try {
			const result = await this.#save();
			if (result.ok) this.leave();
			else this.error = result.error;
		} finally {
			this.saving = false;
		}
	}
}
