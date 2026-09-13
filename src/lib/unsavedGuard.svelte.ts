export type SaveResult = { ok: true } | { ok: false; error: string };
export type SaveFn = () => Promise<SaveResult>;

// Owns both the dirty/save registration (as before) and the "you have unsaved changes, save or
// discard before leaving?" prompt's own state -- previously that modal's open/isSaving/error
// state lived in AdminTopBar.svelte alone, reachable only from its own Home/Sign-out buttons.
// Centralizing it here lets ANY navigation attempt route through the same prompt, not just
// those two -- CaseForm.svelte's own beforeNavigate/beforeunload guards (browser back/forward,
// a link click elsewhere, closing the tab) call requestNavigation the same way AdminTopBar's
// buttons do, so there's one gate instead of two independently-maintained ones.
class UnsavedGuard {
	#dirtySource: (() => boolean) | null = $state(null);
	#saveFn: SaveFn | null = null;

	showModal = $state(false);
	isSaving = $state(false);
	saveError = $state("");
	#pendingAction: (() => void | Promise<void>) | null = null;

	get isDirty(): boolean {
		return this.#dirtySource?.() ?? false;
	}

	register(dirtySource: () => boolean, save: SaveFn): void {
		this.#dirtySource = dirtySource;
		this.#saveFn = save;
	}

	unregister(): void {
		this.#dirtySource = null;
		this.#saveFn = null;
	}

	// Routes a navigation-or-similar action (go home, sign out, follow a link, go back) through
	// the unsaved-changes prompt when there's something to lose; runs it immediately otherwise,
	// so a caller doesn't have to check isDirty itself before deciding whether to call this.
	requestNavigation(action: () => void | Promise<void>): void {
		if (!this.isDirty) {
			void action();
			return;
		}
		this.saveError = "";
		this.#pendingAction = action;
		this.showModal = true;
	}

	closeModal(): void {
		this.showModal = false;
		this.#pendingAction = null;
		this.saveError = "";
	}

	async discard(): Promise<void> {
		const action = this.#pendingAction;
		this.closeModal();
		this.unregister();
		if (action) await action();
	}

	async saveAndContinue(): Promise<void> {
		this.isSaving = true;
		this.saveError = "";
		try {
			const result = await this.save();
			if (!result.ok) {
				this.saveError = result.error;
				return;
			}
			const action = this.#pendingAction;
			this.closeModal();
			if (action) await action();
		} finally {
			this.isSaving = false;
		}
	}

	async save(): Promise<SaveResult> {
		if (!this.#saveFn) return { ok: false, error: "Nothing to save." };
		return this.#saveFn();
	}
}

export const unsavedGuard = new UnsavedGuard();
