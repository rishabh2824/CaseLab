import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { beforeNavigate, goto } from "$app/navigation";
import type { LeaveGuard } from "../../src/lib/case/leaveGuard.svelte.js";
import LeaveGuardHarness from "../support/LeaveGuardHarness.svelte";

// What SvelteKit passes to a beforeNavigate callback.
type Navigation = Parameters<Parameters<typeof beforeNavigate>[0]>[0];

const target = new URL("http://localhost/admin");

// Mounts a guard over a form whose dirty flag the test controls, and returns it with its navigation hook.
async function mountGuard(
	save: () => Promise<
		{ ok: true } | { ok: false; error: string }
	> = async () => ({
		ok: true,
	}),
) {
	const state = { dirty: true };
	let guard!: LeaveGuard;
	const view = await render(LeaveGuardHarness, {
		isDirty: () => state.dirty,
		save,
		onReady: (g: LeaveGuard) => {
			guard = g;
		},
	});
	const hook = vi.mocked(beforeNavigate).mock.calls.at(-1)?.[0];
	if (!hook) throw new Error("expected a beforeNavigate callback");

	// Fires the hook for a navigation and reports whether the guard cancelled it.
	const navigate = (navigation: Partial<Navigation>): boolean => {
		const cancel = vi.fn();
		hook({ to: { url: target }, type: "link", ...navigation, cancel } as never);
		return cancel.mock.calls.length > 0;
	};
	return { guard, state, view, navigate };
}

// Dispatches the event a browser fires before closing or reloading the tab, and reports whether the page asked to stay.
function closeTab(): boolean {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the browser's Back button", () => {
	// Tests that Back with unsaved changes is held, and leaving goes back by the same number of steps.
	it("holds Back and replays it through history when the user leaves", async () => {
		const go = vi.spyOn(history, "go").mockImplementation(() => {});
		const { guard, navigate } = await mountGuard();

		expect(navigate({ type: "popstate", delta: -2 })).toBe(true);
		expect(guard.pending).not.toBeNull();

		guard.leave();

		expect(go).toHaveBeenCalledWith(-2);
		expect(goto).not.toHaveBeenCalled();
		expect(guard.pending).toBeNull();
		expect(navigate({ type: "popstate", delta: -2 })).toBe(false);
	});

	// Tests that a history navigation without a step count is replayed as an ordinary navigation.
	it("falls back to goto when the step count is unknown", async () => {
		const { guard, navigate } = await mountGuard();

		expect(navigate({ type: "popstate" })).toBe(true);
		guard.leave();

		expect(goto).toHaveBeenCalledWith(target);
	});

	// Tests that a navigation with no in-app destination is never held.
	it("lets a navigation with no destination through", async () => {
		const { guard, navigate } = await mountGuard();

		expect(navigate({ to: null })).toBe(false);
		expect(guard.pending).toBeNull();
	});
});

describe("closing or reloading the tab", () => {
	// Tests that the browser's own leave-page prompt appears only while there are unsaved changes.
	it("asks the browser to confirm only while the form is dirty", async () => {
		const { state } = await mountGuard();

		expect(closeTab()).toBe(true);
		state.dirty = false;
		expect(closeTab()).toBe(false);
	});

	// Tests that once the user chose to leave, closing the tab no longer prompts.
	it("stops prompting after the user chose to leave", async () => {
		const { guard, navigate } = await mountGuard();
		navigate({});
		guard.leave();

		expect(closeTab()).toBe(false);
	});

	// Tests that the prompt is removed with the form, so it cannot fire on another page.
	it("stops listening once the form is gone", async () => {
		const { view } = await mountGuard();
		view.unmount();

		expect(closeTab()).toBe(false);
	});
});

describe("save and leave", () => {
	// Tests that a successful save continues the held navigation.
	it("continues after a successful save", async () => {
		const save = vi.fn(async () => ({ ok: true as const }));
		const { guard, navigate } = await mountGuard(save);
		navigate({});

		await guard.saveAndLeave();

		expect(save).toHaveBeenCalledOnce();
		expect(goto).toHaveBeenCalledWith(target);
		expect(guard.saving).toBe(false);
	});

	// Tests that a failed save keeps the dialog open with the error, and does not navigate.
	it("stays with the error when the save fails", async () => {
		const { guard, navigate } = await mountGuard(async () => ({
			ok: false,
			error: "Add a case name.",
		}));
		navigate({});

		await guard.saveAndLeave();

		expect(guard.error).toBe("Add a case name.");
		expect(guard.pending).not.toBeNull();
		expect(guard.saving).toBe(false);
		expect(goto).not.toHaveBeenCalled();
	});
});
