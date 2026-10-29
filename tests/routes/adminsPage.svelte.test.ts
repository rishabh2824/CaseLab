import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { toast } from "svelte-sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import AdminsPage from "../../src/routes/(app)/admin/admins/+page.svelte";
import { clientServerError } from "../support/convexClientErrors.js";
import { convexFake } from "../support/convexFake.svelte.js";

let viewer: { data?: { role: string }; isLoading: boolean };

vi.mock("#lib/adminViewer.js", () => ({
	getViewerContext: () => viewer,
}));

const createAdmin = convexFake.mutation(api.admins.create);
const deleteAdmin = convexFake.mutation(api.admins.deleteWithCascade);

const ADMIN = {
	_id: "a1" as Id<"admins">,
	_creationTime: 0,
	email: "a@wisc.edu",
	name: "Ada",
	role: "admin" as const,
};
const SUPER = {
	_id: "s1" as Id<"admins">,
	_creationTime: 0,
	email: "s@wisc.edu",
	role: "super" as const,
};

// Clicks the confirm button in the delete dialog, which comes after the row's own Delete button.
async function confirmDialog(user: ReturnType<typeof userEvent.setup>) {
	const buttons = await screen.findAllByRole("button", { name: "Delete" });
	await user.click(buttons.at(-1) as HTMLElement);
}

beforeEach(() => {
	viewer = { data: { role: "super" }, isLoading: false };
	convexFake.setQueryData(api.admins.listAll, [SUPER, ADMIN]);
});

describe("admins page access", () => {
	// Tests that a non-super admin is bounced back to the admin home and sees nothing.
	it("redirects a non-super admin to /admin", () => {
		viewer = { data: { role: "admin" }, isLoading: false };
		render(AdminsPage);
		expect(goto).toHaveBeenCalledWith("/admin", { replaceState: true });
		expect(screen.queryByText("Manage admins")).toBeNull();
	});

	// Tests that nobody is redirected before the viewer has loaded.
	it("does not redirect while the viewer is still loading", () => {
		viewer = { data: undefined, isLoading: true };
		render(AdminsPage);
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that a super admin sees the page.
	it("shows the page to a super admin", () => {
		render(AdminsPage);
		expect(goto).not.toHaveBeenCalled();
		expect(
			screen.getByRole("heading", { name: "Manage admins" }),
		).toBeInTheDocument();
	});
});

describe("admins list", () => {
	// Tests that each row shows its details and only non-super admins can be deleted.
	it("lists admins and offers delete only for non-super admins", () => {
		render(AdminsPage);
		expect(screen.getByText("a@wisc.edu")).toBeInTheDocument();
		expect(screen.getByText("Ada")).toBeInTheDocument();
		expect(
			screen.getByRole("cell", { name: "Super Admin" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Super admins can't be deleted"),
		).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
	});

	// Tests that loading, error and empty states each get their own message.
	it("shows loading, error and empty states", () => {
		convexFake.setQuery(api.admins.listAll, undefined, { isLoading: true });
		const loading = render(AdminsPage);
		expect(screen.getByText("Loading admins…")).toBeInTheDocument();
		loading.unmount();

		convexFake.setQuery(api.admins.listAll, undefined, {
			error: clientServerError(getFunctionName(api.admins.listAll), "Q"),
		});
		const failed = render(AdminsPage);
		expect(screen.getByText("Failed to load admins.")).toBeInTheDocument();
		failed.unmount();

		convexFake.setQueryData(api.admins.listAll, []);
		render(AdminsPage);
		expect(screen.getByText("No admins yet.")).toBeInTheDocument();
	});
});

describe("adding an admin", () => {
	// Tests that the form sends trimmed values, then resets and confirms.
	it("creates the admin with trimmed values, resets the form and toasts", async () => {
		createAdmin.mockResolvedValue(ADMIN);
		const user = userEvent.setup();
		render(AdminsPage);
		await user.type(screen.getByLabelText("Email"), "  new@wisc.edu ");
		await user.type(screen.getByLabelText("Name (optional)"), " New Person ");
		await user.selectOptions(screen.getByLabelText("Role"), "super");
		await user.click(screen.getByRole("button", { name: "Add admin" }));

		await waitFor(() =>
			expect(createAdmin).toHaveBeenCalledWith({
				email: "new@wisc.edu",
				name: "New Person",
				role: "super",
			}),
		);
		expect(toast).toHaveBeenCalledWith("Added new@wisc.edu.", {
			duration: 4000,
		});
		expect(screen.getByLabelText("Email")).toHaveValue("");
		expect(screen.getByLabelText("Name (optional)")).toHaveValue("");
		expect(screen.getByLabelText("Role")).toHaveValue("admin");
	});

	// Tests that a blank name is omitted instead of sent as an empty string.
	it("omits a blank name", async () => {
		createAdmin.mockResolvedValue(ADMIN);
		const user = userEvent.setup();
		render(AdminsPage);
		await user.type(screen.getByLabelText("Email"), "new@wisc.edu");
		await user.click(screen.getByRole("button", { name: "Add admin" }));
		await waitFor(() =>
			expect(createAdmin).toHaveBeenCalledWith({
				email: "new@wisc.edu",
				name: undefined,
				role: "admin",
			}),
		);
	});

	// Tests that a server failure toasts a safe message and keeps the typed values.
	it("toasts a safe message and keeps the input when adding fails", async () => {
		createAdmin.mockRejectedValue(
			clientServerError(getFunctionName(api.admins.create)),
		);
		const user = userEvent.setup();
		render(AdminsPage);
		await user.type(screen.getByLabelText("Email"), "new@wisc.edu");
		await user.click(screen.getByRole("button", { name: "Add admin" }));
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith("Failed to add admin."),
		);
		expect(screen.getByLabelText("Email")).toHaveValue("new@wisc.edu");
		expect(screen.getByRole("button", { name: "Add admin" })).toBeEnabled();
	});
});

describe("deleting an admin", () => {
	// Tests that delete asks for confirmation before calling the server.
	it("confirms first, and cancelling deletes nothing", async () => {
		const user = userEvent.setup();
		render(AdminsPage);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		expect(await screen.findByText("Delete a@wisc.edu?")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByText("Delete a@wisc.edu?")).toBeNull(),
		);
		expect(deleteAdmin).not.toHaveBeenCalled();
	});

	// Tests that the toast says how many cases were deleted along with the admin.
	it("deletes and summarises the deleted cases", async () => {
		deleteAdmin.mockResolvedValue({ casesDeleted: 2 });
		const user = userEvent.setup();
		render(AdminsPage);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await confirmDialog(user);
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				"Deleted a@wisc.edu — 2 cases deleted.",
				{ duration: 4000 },
			),
		);
		expect(deleteAdmin).toHaveBeenCalledWith({
			adminId: "a1",
		});
	});

	// Tests that a plain delete says only that the admin was deleted.
	it("toasts a plain message when no cases were affected", async () => {
		deleteAdmin.mockResolvedValue({
			casesDeleted: 0,
		});
		const user = userEvent.setup();
		render(AdminsPage);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await confirmDialog(user);
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith("Deleted a@wisc.edu.", {
				duration: 4000,
			}),
		);
	});

	// Tests that a failed delete keeps the dialog open with a safe error toast.
	it("toasts a safe message when deleting fails", async () => {
		deleteAdmin.mockRejectedValue(
			clientServerError(getFunctionName(api.admins.deleteWithCascade)),
		);
		const user = userEvent.setup();
		render(AdminsPage);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await confirmDialog(user);
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith("Failed to delete admin."),
		);
		expect(screen.getByText("Delete a@wisc.edu?")).toBeInTheDocument();
	});
});
