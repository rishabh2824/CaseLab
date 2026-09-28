export type SaveResult = { ok: true } | { ok: false; error: string };
export type SaveFn = () => Promise<SaveResult>;

class UnsavedGuard {
	#dirtySource: (() => boolean) | null = $state(null);
	#saveFn: SaveFn | null = null;

	showModal = $state(false);
	isSaving = $state(false);
	saveError = $state("");
	#pendingAction: (() => void | Promise<void>) | null = null;

	// Returns whether the registered form currently has unsaved changes.
	get isDirty(): boolean {
		return this.#dirtySource?.() ?? false;
	}

	// Registers the form's dirty check and save function.
	register(dirtySource: () => boolean, save: SaveFn): void {
		this.#dirtySource = dirtySource;
		this.#saveFn = save;
	}

	// Removes the registered dirty check and save function.
	unregister(): void {
		this.#dirtySource = null;
		this.#saveFn = null;
	}

	// Runs a navigation action right away if the form is clean, otherwise asks the user via the modal.
	requestNavigation(action: () => void | Promise<void>): void {
		if (!this.isDirty) {
			void action();
			return;
		}
		this.saveError = "";
		this.#pendingAction = action;
		this.showModal = true;
	}

	// Closes the unsaved-changes modal and forgets the pending navigation.
	closeModal(): void {
		this.showModal = false;
		this.#pendingAction = null;
		this.saveError = "";
	}

	// Drops the unsaved changes and continues with the pending navigation.
	async discard(): Promise<void> {
		const action = this.#pendingAction;
		this.closeModal();
		this.unregister();
		if (action) await action();
	}

	// Saves the form and, if that succeeds, continues with the pending navigation.
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

	// Runs the registered save function, or reports there is nothing to save.
	async save(): Promise<SaveResult> {
		if (!this.#saveFn) return { ok: false, error: "Nothing to save." };
		return this.#saveFn();
	}
}

export const unsavedGuard = new UnsavedGuard();
