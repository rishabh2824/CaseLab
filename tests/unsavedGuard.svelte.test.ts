import { beforeEach, describe, expect, it, vi } from "vitest";
import { unsavedGuard } from "../src/lib/unsavedGuard.svelte.js";

// Registers a form that is dirty or clean, with the given save function.
function registerForm(
	dirty: boolean,
	save = vi.fn(async () => ({ ok: true })),
) {
	unsavedGuard.register(() => dirty, save as never);
	return save;
}

beforeEach(() => {
	unsavedGuard.unregister();
	unsavedGuard.closeModal();
	unsavedGuard.isSaving = false;
});

describe("isDirty", () => {
	// Tests that nothing registered counts as clean.
	it("is false with no registered form", () => {
		expect(unsavedGuard.isDirty).toBe(false);
	});

	// Tests that the guard follows the registered dirty check live.
	it("reflects the registered dirty check and clears on unregister", () => {
		let dirty = false;
		unsavedGuard.register(
			() => dirty,
			async () => ({ ok: true }),
		);
		expect(unsavedGuard.isDirty).toBe(false);
		dirty = true;
		expect(unsavedGuard.isDirty).toBe(true);
		unsavedGuard.unregister();
		expect(unsavedGuard.isDirty).toBe(false);
	});
});

describe("requestNavigation", () => {
	// Tests that a clean form navigates straight away without the modal.
	it("runs the action immediately when the form is clean", () => {
		registerForm(false);
		const action = vi.fn();
		unsavedGuard.requestNavigation(action);
		expect(action).toHaveBeenCalledOnce();
		expect(unsavedGuard.showModal).toBe(false);
	});

	// Tests that a dirty form holds the action and opens the modal with a cleared error.
	it("holds the action and opens the modal when the form is dirty", () => {
		registerForm(true);
		unsavedGuard.saveError = "old error";
		const action = vi.fn();
		unsavedGuard.requestNavigation(action);
		expect(action).not.toHaveBeenCalled();
		expect(unsavedGuard.showModal).toBe(true);
		expect(unsavedGuard.saveError).toBe("");
	});
});

describe("closeModal", () => {
	// Tests that cancelling drops the pending action so it can never run later.
	it("forgets the pending action", async () => {
		registerForm(true);
		const action = vi.fn();
		unsavedGuard.requestNavigation(action);
		unsavedGuard.closeModal();
		expect(unsavedGuard.showModal).toBe(false);
		await unsavedGuard.discard();
		expect(action).not.toHaveBeenCalled();
	});
});

describe("discard", () => {
	// Tests that discarding closes the modal, unregisters the form and runs the held action.
	it("closes the modal, unregisters the form and continues", async () => {
		registerForm(true);
		const action = vi.fn();
		unsavedGuard.requestNavigation(action);
		await unsavedGuard.discard();
		expect(action).toHaveBeenCalledOnce();
		expect(unsavedGuard.showModal).toBe(false);
		expect(unsavedGuard.isDirty).toBe(false);
	});

	// Tests that discarding with nothing pending does not throw.
	it("is safe with no pending action", async () => {
		registerForm(true);
		await expect(unsavedGuard.discard()).resolves.toBeUndefined();
	});
});

describe("saveAndContinue", () => {
	// Tests that a successful save closes the modal and runs the held action.
	it("saves, then closes the modal and continues", async () => {
		const save = registerForm(true);
		const action = vi.fn();
		unsavedGuard.requestNavigation(action);
		await unsavedGuard.saveAndContinue();
		expect(save).toHaveBeenCalledOnce();
		expect(action).toHaveBeenCalledOnce();
		expect(unsavedGuard.showModal).toBe(false);
		expect(unsavedGuard.isSaving).toBe(false);
	});

	// Tests that a failed save keeps the modal open, shows the error and does not navigate.
	it("keeps the modal open and shows the error when saving fails", async () => {
		registerForm(
			true,
			vi.fn(async () => ({ ok: false, error: "Nope." })),
		);
		const action = vi.fn();
		unsavedGuard.requestNavigation(action);
		await unsavedGuard.saveAndContinue();
		expect(action).not.toHaveBeenCalled();
		expect(unsavedGuard.showModal).toBe(true);
		expect(unsavedGuard.saveError).toBe("Nope.");
		expect(unsavedGuard.isSaving).toBe(false);
	});

	// Tests that a throwing save still clears the saving flag.
	it("clears isSaving even when the save throws", async () => {
		registerForm(
			true,
			vi.fn(async () => Promise.reject(new Error("boom"))),
		);
		unsavedGuard.requestNavigation(vi.fn());
		await expect(unsavedGuard.saveAndContinue()).rejects.toThrow("boom");
		expect(unsavedGuard.isSaving).toBe(false);
	});

	// Tests that isSaving is true while the save is in flight.
	it("marks isSaving while the save runs", async () => {
		let release: (r: { ok: true }) => void = () => {};
		registerForm(
			true,
			vi.fn(() => new Promise<{ ok: true }>((resolve) => (release = resolve))),
		);
		unsavedGuard.requestNavigation(vi.fn());
		const pending = unsavedGuard.saveAndContinue();
		expect(unsavedGuard.isSaving).toBe(true);
		release({ ok: true });
		await pending;
		expect(unsavedGuard.isSaving).toBe(false);
	});
});

describe("save", () => {
	// Tests that saving with no registered form reports there is nothing to save.
	it("reports nothing to save when no form is registered", async () => {
		expect(await unsavedGuard.save()).toEqual({
			ok: false,
			error: "Nothing to save.",
		});
	});

	// Tests that saving delegates to the registered save function.
	it("delegates to the registered save function", async () => {
		const save = registerForm(true);
		expect(await unsavedGuard.save()).toEqual({ ok: true });
		expect(save).toHaveBeenCalledOnce();
	});
});
