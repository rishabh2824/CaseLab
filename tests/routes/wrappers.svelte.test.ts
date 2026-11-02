import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import CaseForm from "../../src/lib/components/case/CaseForm.svelte";
import RootLayout from "../../src/routes/+layout.svelte";
import AppLayout from "../../src/routes/(app)/+layout.svelte";
import EditCase from "../../src/routes/(app)/admin/cases/[id]/+page.svelte";
import BlankCase from "../../src/routes/(app)/admin/cases/new/blank/+page.svelte";
import TemplateCase from "../../src/routes/(app)/admin/cases/new/template/[id]/+page.svelte";
import { convexFake } from "../support/convexFake.svelte.js";

let pageState: { url: URL; params: Record<string, string> };

vi.mock("$app/state", () => ({
	get page() {
		return pageState;
	},
}));

vi.mock("svelte-sonner", async (importOriginal) => ({
	...(await importOriginal<typeof import("svelte-sonner")>()),
	toast: vi.fn(),
}));

vi.mock("../../src/lib/components/case/CaseForm.svelte", () => ({
	default: vi.fn(),
}));

const children = createRawSnippet(() => ({
	render: () => "<p>page body</p>",
}));

// Returns the props a stubbed component was rendered with.
function propsOf(component: unknown): Record<string, unknown> {
	return (component as Mock).mock.calls[0]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
	pageState = {
		url: new URL("http://localhost/admin/cases/new/blank"),
		params: {},
	};
});

describe("admin case pages", () => {
	// Tests that the blank page opens an empty form.
	it("opens the blank create form", () => {
		render(BlankCase);
		expect(propsOf(CaseForm)).toMatchObject({ source: { kind: "new" } });
	});

	// Tests that the template page seeds the new case from the template named in the route.
	it("copies the template named in the route", () => {
		pageState.params = { id: "abc" };
		render(TemplateCase);
		expect(propsOf(CaseForm)).toMatchObject({
			source: { kind: "template", id: "abc" },
		});
	});

	// Tests that the edit page loads the case named in the route.
	it("edits the case named in the route", () => {
		pageState.params = { id: "case-9" };
		render(EditCase);
		expect(propsOf(CaseForm)).toMatchObject({
			source: { kind: "edit", id: "case-9" },
		});
	});
});

describe("layouts", () => {
	// Tests that the root layout connects Convex and renders the page in main.
	it("sets up Convex and renders children inside main", () => {
		render(RootLayout, { props: { children } });
		expect(convexFake.setupConvex).toHaveBeenCalledOnce();
		const [url, options] = convexFake.setupConvex.mock.calls[0] as [
			string,
			unknown,
		];
		expect(typeof url).toBe("string");
		expect(options).toEqual({ initialAuthTokenReuse: true });
		expect(screen.getByRole("main")).toHaveTextContent("page body");
	});

	// Tests that the app layout keeps its pages out of search engines and mounts the toaster.
	it("marks app pages noindex and renders children with a toaster", () => {
		window.matchMedia = vi.fn(
			() =>
				({
					matches: false,
					addEventListener: vi.fn(),
					removeEventListener: vi.fn(),
				}) as unknown as MediaQueryList,
		);
		render(AppLayout, { props: { children } });
		expect(screen.getByText("page body")).toBeInTheDocument();
		expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute(
			"content",
			"noindex, nofollow",
		);
		expect(screen.getByLabelText(/Notifications/)).toBeInTheDocument();
	});
});
