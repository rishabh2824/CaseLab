// Global bridge between CaseForm (which owns the actual case-editing state)
// and AdminTopBar (which needs to know whether it's safe to navigate away,
// regardless of which admin route CaseForm happens to be mounted under).
export type SaveResult = { ok: true } | { ok: false; error: string };
export type SaveHandler = () => Promise<SaveResult>;

class CaseEditState {
	isDirty = $state(false);
	#saveHandler: SaveHandler | null = null;

	setDirty(value: boolean): void {
		this.isDirty = value;
	}

	// CaseForm registers itself on mount and unregisters on destroy, so a save
	// request outside of any case-editing route is a well-defined no-op.
	registerSaveHandler(handler: SaveHandler | null): void {
		this.#saveHandler = handler;
	}

	async save(): Promise<SaveResult> {
		if (!this.#saveHandler) return { ok: false, error: "Nothing to save." };
		return this.#saveHandler();
	}
}

export const caseEditState = new CaseEditState();
