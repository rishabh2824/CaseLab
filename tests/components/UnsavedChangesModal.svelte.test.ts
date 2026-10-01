import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import UnsavedChangesModal from "../../src/lib/components/UnsavedChangesModal.svelte";

// Renders the modal with defaults and returns its callbacks.
function renderModal(
	props: Partial<{
		open: boolean;
		isSaving: boolean;
		errorMessage: string;
	}> = {},
) {
	const onSave = vi.fn();
	const onDiscard = vi.fn();
	render(UnsavedChangesModal, {
		props: {
			open: true,
			isSaving: false,
			errorMessage: "",
			onSave,
			onDiscard,
			...props,
		},
	});
	return { onSave, onDiscard };
}

describe("UnsavedChangesModal", () => {
	// Tests that nothing is shown while closed.
	it("renders nothing when closed", () => {
		renderModal({ open: false });
		expect(screen.queryByText("You have unsaved changes")).toBeNull();
	});

	// Tests that the open modal offers all three choices.
	it("offers cancel, discard and save when open", () => {
		renderModal();
		expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
		expect(
			screen.getByRole("button", { name: "Discard changes" }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
	});

	// Tests that each action button calls its own callback.
	it("calls onSave and onDiscard from their buttons", async () => {
		const user = userEvent.setup();
		const { onSave, onDiscard } = renderModal();
		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		expect(onDiscard).toHaveBeenCalledOnce();
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		expect(onSave).toHaveBeenCalledOnce();
	});

	// Tests that a save error is shown to the user.
	it("shows the error message", () => {
		renderModal({ errorMessage: "Could not save." });
		expect(screen.getByText("Could not save.")).toBeInTheDocument();
	});

	// Tests that every button is locked and the label changes while saving.
	it("disables all buttons and shows Saving while saving", () => {
		renderModal({ isSaving: true });
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Discard changes" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
	});
});
