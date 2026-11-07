import { getFunctionName } from "convex/server";
import { toast } from "svelte-sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { goto } from "$app/navigation";
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
	name: "Sam",
	role: "super" as const,
};

const emailBox = () => page.getByLabelText("Email");
const nameBox = () => page.getByLabelText("Name");
const roleBox = () => page.getByLabelText("Role");
const addAdmin = () => page.getByRole("button", { name: "Add admin" });
const rowDelete = () => page.getByRole("button", { name: "Delete" });

// Opens the delete dialog for Ada and clicks its confirm button, the last Delete button on the page.
async function confirmDelete() {
	await rowDelete().click();
	await expect.element(page.getByText("Delete a@wisc.edu?")).toBeVisible();
	await rowDelete().last().click();
}

beforeEach(() => {
	viewer = { data: { role: "super" }, isLoading: false };
	convexFake.setQueryData(api.admins.listAll, [SUPER, ADMIN]);
});

describe("admins page access", () => {
	// Tests that a non-super admin is bounced back to the admin home and sees nothing.
	it("redirects a non-super admin to /admin", async () => {
		viewer = { data: { role: "admin" }, isLoading: false };
		await render(AdminsPage);
		expect(goto).toHaveBeenCalledWith("/admin", { replaceState: true });
		await expect
			.element(page.getByText("Manage admins"))
			.not.toBeInTheDocument();
	});

	// Tests that nobody is redirected before the viewer has loaded.
	it("does not redirect while the viewer is still loading", async () => {
		viewer = { data: undefined, isLoading: true };
		await render(AdminsPage);
		expect(goto).not.toHaveBeenCalled();
	});

	// Tests that a super admin sees the page.
	it("shows the page to a super admin", async () => {
		await render(AdminsPage);
		expect(goto).not.toHaveBeenCalled();
		await expect
			.element(page.getByRole("heading", { name: "Manage admins" }))
			.toBeVisible();
	});
});

describe("admins list", () => {
	// Tests that each row shows its details and only non-super admins can be deleted.
	it("lists admins and offers delete only for non-super admins", async () => {
		await render(AdminsPage);
		await expect.element(page.getByText("a@wisc.edu")).toBeVisible();
		await expect.element(page.getByText("Ada")).toBeVisible();
		await expect
			.element(page.getByRole("cell", { name: "Super Admin" }))
			.toBeVisible();
		await expect
			.element(page.getByText("Super admins can't be deleted"))
			.toBeVisible();
		expect(rowDelete().elements()).toHaveLength(1);
	});

	// Tests that loading, error and empty states each get their own message.
	it("shows loading, error and empty states", async () => {
		convexFake.setQuery(api.admins.listAll, undefined, { isLoading: true });
		const loading = await render(AdminsPage);
		await expect.element(page.getByText("Loading admins…")).toBeVisible();
		loading.unmount();

		convexFake.setQuery(api.admins.listAll, undefined, {
			error: clientServerError(getFunctionName(api.admins.listAll), "Q"),
		});
		const failed = await render(AdminsPage);
		await expect
			.element(page.getByText("Failed to load admins."))
			.toBeVisible();
		failed.unmount();

		convexFake.setQueryData(api.admins.listAll, []);
		await render(AdminsPage);
		await expect.element(page.getByText("No admins yet.")).toBeVisible();
	});
});

describe("adding an admin", () => {
	// Tests that the form sends the typed values, then resets and confirms with the saved admin's email.
	it("creates the admin, resets the form and toasts", async () => {
		createAdmin.mockResolvedValue({ ...ADMIN, email: "new@wisc.edu" });
		await render(AdminsPage);
		await emailBox().fill("new@wisc.edu");
		await nameBox().fill("New Person");
		await roleBox().selectOptions("super");
		await addAdmin().click();

		await vi.waitFor(() =>
			expect(createAdmin).toHaveBeenCalledWith({
				email: "new@wisc.edu",
				name: "New Person",
				role: "super",
			}),
		);
		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith("Added new@wisc.edu.", {
				duration: 4000,
			}),
		);
		await expect.element(emailBox()).toHaveValue("");
		await expect.element(nameBox()).toHaveValue("");
		await expect.element(roleBox()).toHaveValue("admin");
	});

	// Tests that a server failure toasts a safe message and keeps the typed values.
	it("toasts a safe message and keeps the input when adding fails", async () => {
		createAdmin.mockRejectedValue(
			clientServerError(getFunctionName(api.admins.create)),
		);
		await render(AdminsPage);
		await emailBox().fill("new@wisc.edu");
		await nameBox().fill("New Person");
		await addAdmin().click();
		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith("Failed to add admin."),
		);
		await expect.element(emailBox()).toHaveValue("new@wisc.edu");
		await expect.element(addAdmin()).toBeEnabled();
	});
});

describe("deleting an admin", () => {
	// Tests that delete asks for confirmation before calling the server.
	it("confirms first, and cancelling deletes nothing", async () => {
		await render(AdminsPage);
		await rowDelete().click();
		await expect.element(page.getByText("Delete a@wisc.edu?")).toBeVisible();
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect
			.element(page.getByText("Delete a@wisc.edu?"))
			.not.toBeInTheDocument();
		expect(deleteAdmin).not.toHaveBeenCalled();
	});

	// Tests that the toast says how many cases were deleted along with the admin.
	it("deletes and summarises the deleted cases", async () => {
		deleteAdmin.mockResolvedValue({ casesDeleted: 2 });
		await render(AdminsPage);
		await confirmDelete();
		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				"Deleted a@wisc.edu — 2 cases deleted.",
				{ duration: 4000 },
			),
		);
		expect(deleteAdmin).toHaveBeenCalledWith({ adminId: "a1" });
	});

	// Tests that a plain delete says only that the admin was deleted.
	it("toasts a plain message when no cases were affected", async () => {
		deleteAdmin.mockResolvedValue({ casesDeleted: 0 });
		await render(AdminsPage);
		await confirmDelete();
		await vi.waitFor(() =>
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
		await render(AdminsPage);
		await confirmDelete();
		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith("Failed to delete admin."),
		);
		await expect.element(page.getByText("Delete a@wisc.edu?")).toBeVisible();
	});
});
