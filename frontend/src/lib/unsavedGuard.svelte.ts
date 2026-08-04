// Bridge between CaseForm (which owns the actual case-editing state) and
// AdminTopBar (which needs to know whether it's safe to navigate away,
// regardless of which admin route CaseForm happens to be mounted under).
//
// A module singleton behind a factory, not Svelte context: the whole app
// renders client-only (routes/+layout.ts sets `ssr = false`), so there's no
// SSR cross-request-leak risk, and AdminTopBar/CaseForm are permanent layout
// siblings under (app)/admin/+layout.svelte that never remount across
// navigation — so context would have exactly this lifetime anyway, with more
// ceremony.
export type SaveResult = { ok: true } | { ok: false; error: string };
export type SaveFn = () => Promise<SaveResult>;

class UnsavedGuard {
	#dirtySource: (() => boolean) | null = $state(null);
	#saveFn: SaveFn | null = null;

	get isDirty(): boolean {
		return this.#dirtySource?.() ?? false;
	}

	// CaseForm registers itself on mount and unregisters on destroy, so a save
	// request outside of any case-editing route is a well-defined no-op.
	register(dirtySource: () => boolean, save: SaveFn): void {
		this.#dirtySource = dirtySource;
		this.#saveFn = save;
	}

	unregister(): void {
		this.#dirtySource = null;
		this.#saveFn = null;
	}

	async save(): Promise<SaveResult> {
		if (!this.#saveFn) return { ok: false, error: "Nothing to save." };
		return this.#saveFn();
	}
}

export const unsavedGuard = new UnsavedGuard();
