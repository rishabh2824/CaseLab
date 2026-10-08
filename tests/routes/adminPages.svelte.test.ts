import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminHome from "../../src/routes/(app)/admin/+page.svelte";
// @ts-expect-error -- this page has no <script>, so svelte-check has no declaration for it
import NewCase from "../../src/routes/(app)/admin/new/+page.svelte";

let viewer: { data?: { role: string }; isLoading: boolean } = {
	data: undefined,
	isLoading: false,
};

vi.mock("#lib/adminViewer.js", () => ({
	getViewerContext: () => viewer,
}));

beforeEach(() => {
	viewer = { data: { role: "admin" }, isLoading: false };
});

describe("admin home", () => {
	// Tests that the two main entry points are always offered.
	it("links to creating and editing cases", () => {
		render(AdminHome);
		expect(
			screen.getByRole("link", { name: /Create New Case/ }),
		).toHaveAttribute("href", "/admin/new");
		expect(
			screen.getByRole("link", { name: /Edit Existing Case/ }),
		).toHaveAttribute("href", "/admin/edit");
	});

	// Tests that only a super admin is offered the roster page.
	it("shows Manage admins to a super admin only", () => {
		viewer = { data: { role: "super" }, isLoading: false };
		const { unmount } = render(AdminHome);
		expect(screen.getByRole("link", { name: "Manage admins" })).toHaveAttribute(
			"href",
			"/admin/admins",
		);
		unmount();

		viewer = { data: { role: "admin" }, isLoading: false };
		render(AdminHome);
		expect(screen.queryByRole("link", { name: "Manage admins" })).toBeNull();
	});

	// Tests that the link stays hidden until the viewer has loaded.
	it("hides Manage admins while the viewer is loading", () => {
		viewer = { data: undefined, isLoading: true };
		render(AdminHome);
		expect(screen.queryByRole("link", { name: "Manage admins" })).toBeNull();
	});
});

describe("new case chooser", () => {
	// Tests that all three ways to begin a case are offered.
	it("links to the blank form, the template picker and the demo", () => {
		render(NewCase);
		expect(
			screen.getByRole("link", { name: /Start From Scratch/ }),
		).toHaveAttribute("href", "/admin/cases/new");
		expect(
			screen.getByRole("link", { name: /Use Existing Case As Template/ }),
		).toHaveAttribute("href", "/admin/new/template");
		expect(
			screen.getByRole("link", { name: /View demo cases/ }),
		).toHaveAttribute("href", "/admin/new/demo");
	});
});
