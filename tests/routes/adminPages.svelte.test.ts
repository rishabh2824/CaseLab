import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import AdminHome from "../../src/routes/(app)/admin/+page.svelte";
import NewCase from "../../src/routes/(app)/admin/cases/new/+page.svelte";

let viewer: { data?: { role: string }; isLoading: boolean } = {
	data: undefined,
	isLoading: false,
};

vi.mock("#lib/adminViewer.js", () => ({
	getViewerContext: () => viewer,
}));

const manageAdmins = () => page.getByRole("link", { name: "Manage admins" });

beforeEach(() => {
	viewer = { data: { role: "admin" }, isLoading: false };
});

describe("admin home", () => {
	// Tests that the two main entry points are always offered.
	it("links to creating and editing cases", async () => {
		await render(AdminHome);
		await expect
			.element(page.getByRole("link", { name: /Create New Case/ }))
			.toHaveAttribute("href", "/admin/cases/new");
		await expect
			.element(page.getByRole("link", { name: /Edit Existing Case/ }))
			.toHaveAttribute("href", "/admin/cases");
	});

	// Tests that only a super admin is offered the roster page.
	it("shows Manage admins to a super admin only", async () => {
		viewer = { data: { role: "super" }, isLoading: false };
		const first = await render(AdminHome);
		await expect
			.element(manageAdmins())
			.toHaveAttribute("href", "/admin/admins");
		first.unmount();

		viewer = { data: { role: "admin" }, isLoading: false };
		await render(AdminHome);
		await expect.element(manageAdmins()).not.toBeInTheDocument();
	});

	// Tests that the link stays hidden until the viewer has loaded.
	it("hides Manage admins while the viewer is loading", async () => {
		viewer = { data: undefined, isLoading: true };
		await render(AdminHome);
		await expect.element(manageAdmins()).not.toBeInTheDocument();
	});
});

describe("new case chooser", () => {
	// Tests that both ways to begin a case are offered.
	it("links to the blank form and the template picker", async () => {
		await render(NewCase);
		await expect
			.element(page.getByRole("link", { name: /Start From Scratch/ }))
			.toHaveAttribute("href", "/admin/cases/new/blank");
		await expect
			.element(
				page.getByRole("link", { name: /Use Existing Case As Template/ }),
			)
			.toHaveAttribute("href", "/admin/cases/new/template");
	});
});
