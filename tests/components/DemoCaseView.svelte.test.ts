import { render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel.js";
import DemoCaseView from "../../src/lib/components/DemoCaseView.svelte";
import { clientServerError } from "../support/convexClientErrors.js";
import { makePersonaPayload } from "../support/fixtures.js";

const mockUseQuery = vi.fn();

vi.mock("convex-svelte", () => ({
	useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

// Builds a demo case with two root personas, one referred persona and a file.
function makeDemoCase() {
	return {
		name: "Demo Corp",
		accessCode: "demo-code",
		duration: 30,
		brief: "Cut costs.",
		commonInformation: "Founded in 1999.",
		structure: {
			roots: ["a"],
			personas: [
				makePersonaPayload({
					id: "a",
					name: "Alice",
					role: "CFO",
					known_facts: "Knows the budget.",
					personality_traits: "Blunt",
					availability_minutes: 15,
					files: [
						{
							file: {
								storage_id: "st1" as Id<"_storage">,
								file_name: "budget.pdf",
								content_type: "application/pdf",
							},
							share_conditions: "Asked for the budget",
							perceived_contents: "Q3 numbers",
						},
					],
				}),
				makePersonaPayload({ id: "b", name: "Bob", role: "Analyst" }),
				makePersonaPayload({ id: "c", name: "  ", role: "Intern" }),
			],
			referrals: [
				{ from_id: "a", to_id: "b", conditions: "Alice trusts the user" },
				{ from_id: "b", to_id: "c", conditions: "" },
			],
		},
	};
}

// Stubs the demo query with a data, loading or error state.
function stubQuery(state: {
	data?: unknown;
	isLoading?: boolean;
	error?: Error;
}) {
	mockUseQuery.mockReturnValue({
		data: state.data,
		isLoading: state.isLoading ?? false,
		error: state.error,
	});
}

beforeEach(() => {
	mockUseQuery.mockReset();
});

describe("DemoCaseView", () => {
	// Tests that a loading state is shown while the query runs.
	it("shows a loading message", () => {
		stubQuery({ isLoading: true });
		render(DemoCaseView);
		expect(screen.getByText("Loading demo case...")).toBeInTheDocument();
	});

	// Tests that a real-shaped redacted error falls back to the friendly message.
	it("shows a friendly message when the query fails", () => {
		stubQuery({ error: clientServerError("api/cases:getDemo", "Q") });
		render(DemoCaseView);
		expect(
			screen.getByText("Failed to load the demo case."),
		).toBeInTheDocument();
	});

	// Tests that a deployment without a demo case says so.
	it("says so when no demo case is configured", () => {
		stubQuery({ data: null });
		render(DemoCaseView);
		expect(
			screen.getByText("No demo case is set up for this deployment."),
		).toBeInTheDocument();
	});

	// Tests that the case details are rendered read-only.
	it("renders the case information", () => {
		stubQuery({ data: makeDemoCase() });
		render(DemoCaseView);
		expect(
			screen.getByRole("heading", { name: "Demo Corp" }),
		).toBeInTheDocument();
		expect(screen.getByText("demo-code")).toBeInTheDocument();
		expect(screen.getByText("30")).toBeInTheDocument();
		expect(screen.getByText("Cut costs.")).toBeInTheDocument();
		expect(screen.getByText("Founded in 1999.")).toBeInTheDocument();
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	// Tests that an unlimited case shows the placeholder instead of a blank duration.
	it("shows Unlimited when the case has no duration", () => {
		stubQuery({ data: { ...makeDemoCase(), duration: undefined } });
		render(DemoCaseView);
		expect(screen.getAllByText("Unlimited").length).toBeGreaterThan(0);
	});

	// Tests that root personas are listed by name and referred ones show who refers to them.
	it("lists root personas and labels referred personas with their referrer", () => {
		stubQuery({ data: makeDemoCase() });
		render(DemoCaseView);
		expect(
			screen.getByText("Alice", { selector: "summary" }),
		).toBeInTheDocument();
		expect(screen.getByText("Bob ← Alice")).toBeInTheDocument();
		expect(screen.getByText("Referred Persona 2 ← Bob")).toBeInTheDocument();
	});

	// Tests that a persona's details, file and referral are rendered inside its card.
	it("shows a persona's facts, files and referrals", () => {
		stubQuery({ data: makeDemoCase() });
		render(DemoCaseView);
		const card = screen
			.getByText("Alice", { selector: "summary" })
			.closest("details") as HTMLElement;
		expect(within(card).getByText("Knows the budget.")).toBeInTheDocument();
		expect(within(card).getByText("Blunt")).toBeInTheDocument();
		expect(within(card).getByText("15")).toBeInTheDocument();
		expect(within(card).getByText("File 1: budget.pdf")).toBeInTheDocument();
		expect(within(card).getByText("Asked for the budget")).toBeInTheDocument();
		expect(within(card).getByText("Q3 numbers")).toBeInTheDocument();
		expect(within(card).getByText("Refers out to")).toBeInTheDocument();
		expect(within(card).getByText("Alice trusts the user")).toBeInTheDocument();
	});

	// Tests that empty optional fields show their placeholders.
	it("shows placeholders for empty persona fields", () => {
		stubQuery({ data: makeDemoCase() });
		render(DemoCaseView);
		const card = screen
			.getByText("Bob ← Alice")
			.closest("details") as HTMLElement;
		expect(within(card).getAllByText("Not set").length).toBeGreaterThan(0);
		expect(within(card).getByText("None")).toBeInTheDocument();
		expect(within(card).getByText("No conditions set")).toBeInTheDocument();
	});

	// Tests that a case with no personas says so.
	it("says so when the case has no personas", () => {
		stubQuery({
			data: {
				...makeDemoCase(),
				structure: { roots: [], personas: [], referrals: [] },
			},
		});
		render(DemoCaseView);
		expect(screen.getByText("No personas in this case.")).toBeInTheDocument();
	});
});
