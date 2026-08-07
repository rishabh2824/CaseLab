export type SaveResult = { ok: true } | { ok: false; error: string };
export type SaveFn = () => Promise<SaveResult>;

class UnsavedGuard {
	#dirtySource: (() => boolean) | null = $state(null);
	#saveFn: SaveFn | null = null;

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

	async save(): Promise<SaveResult> {
		if (!this.#saveFn) return { ok: false, error: "Nothing to save." };
		return this.#saveFn();
	}
}

export const unsavedGuard = new UnsavedGuard();
