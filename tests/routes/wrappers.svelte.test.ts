import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import CaseForm from "../../src/lib/components/CaseForm.svelte";
import DemoCaseView from "../../src/lib/components/DemoCaseView.svelte";
import TemplatePicker from "../../src/lib/components/TemplatePicker.svelte";
import RootLayout from "../../src/routes/+layout.svelte";
import AppLayout from "../../src/routes/(app)/+layout.svelte";
import EditCase from "../../src/routes/(app)/admin/cases/[id]/edit/+page.svelte";
import NewCase from "../../src/routes/(app)/admin/cases/new/+page.svelte";
import EditList from "../../src/routes/(app)/admin/edit/+page.svelte";
import Demo from "../../src/routes/(app)/admin/new/demo/+page.svelte";
import DemoDetail from "../../src/routes/(app)/admin/new/demo/[id]/+page.svelte";
import Template from "../../src/routes/(app)/admin/new/template/+page.svelte";

const mockSetupConvex = vi.fn();
let pageState: { url: URL; params: Record<string, string> };

vi.mock("$app/state", () => ({
	get page() {
		return pageState;
	},
}));

vi.mock("convex-svelte", () => ({
	setupConvex: (...args: unknown[]) => mockSetupConvex(...args),
}));

vi.mock("svelte-sonner", async (importOriginal) => ({
	...(await importOriginal<typeof import("svelte-sonner")>()),
	toast: vi.fn(),
}));

vi.mock("../../src/lib/components/CaseForm.svelte", () => ({
	default: vi.fn(),
}));
vi.mock("../../src/lib/components/TemplatePicker.svelte", () => ({
	default: vi.fn(),
}));
vi.mock("../../src/lib/components/DemoCaseView.svelte", () => ({
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
		url: new URL("http://localhost/admin/cases/new"),
		params: {},
	};
	mockSetupConvex.mockReset();
});

describe("admin case pages", () => {
	// Tests that a plain new case opens the blank form.
	it("opens the blank create form when there is no template", () => {
		render(NewCase);
		expect(propsOf(CaseForm)).toMatchObject({
			mode: "create",
			templateId: null,
		});
	});

	// Tests that the template query parameter seeds the new case.
	it("passes the template id from the query string", () => {
		pageState.url = new URL("http://localhost/admin/cases/new?template=abc");
		render(NewCase);
		expect(propsOf(CaseForm)).toMatchObject({
			mode: "create",
			templateId: "abc",
		});
	});

	// Tests that the edit page loads the case named in the route.
	it("edits the case named in the route", () => {
		pageState.params = { id: "case-9" };
		render(EditCase);
		expect(propsOf(CaseForm)).toMatchObject({ mode: "edit", caseId: "case-9" });
	});

	// Tests that each list page renders the picker in its own mode.
	it("renders the picker in edit and template modes", () => {
		render(EditList);
		expect(propsOf(TemplatePicker)).toMatchObject({ mode: "edit" });
		(TemplatePicker as unknown as Mock).mockClear();
		render(Template);
		expect(propsOf(TemplatePicker)).toMatchObject({ mode: "template" });
	});

	// Tests that the demo page lists the demo cases through the picker.
	it("renders the picker in demo mode", () => {
		render(Demo);
		expect(propsOf(TemplatePicker)).toMatchObject({ mode: "demo" });
	});

	// Tests that the demo detail page renders the read-only view for the case in the URL.
	it("renders the demo view for the case in the URL", () => {
		pageState.params = { id: "case-7" };
		render(DemoDetail);
		expect(propsOf(DemoCaseView)).toMatchObject({ caseId: "case-7" });
	});
});

describe("layouts", () => {
	// Tests that the root layout connects Convex and renders the page in main.
	it("sets up Convex and renders children inside main", () => {
		render(RootLayout, { props: { children } });
		expect(mockSetupConvex).toHaveBeenCalledOnce();
		const [url, options] = mockSetupConvex.mock.calls[0] as [string, unknown];
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
