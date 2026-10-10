import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import SimulationClock from "../../src/lib/components/SimulationClock.svelte";

// Returns the progress bar element.
function bar(container: HTMLElement): HTMLElement {
	return container.querySelector("[style]") as HTMLElement;
}

describe("SimulationClock", () => {
	// Tests that elapsed and total time are formatted as MM:SS.
	it("shows elapsed and total time as MM:SS", () => {
		render(SimulationClock, {
			props: { elapsedSeconds: 65, totalDurationSeconds: 600 },
		});
		expect(screen.getByText("01:05 / 10:00")).toBeInTheDocument();
	});

	// Tests that an unlimited simulation shows a placeholder total and an empty bar.
	it("shows --:-- and an empty bar when there is no duration", () => {
		const { container } = render(SimulationClock, {
			props: { elapsedSeconds: 30, totalDurationSeconds: null },
		});
		expect(screen.getByText("00:30 / --:--")).toBeInTheDocument();
		expect(bar(container).style.width).toBe("0%");
	});

	// Tests that the bar is green until 80% and turns to the brand colour after.
	it("switches the bar colour once 80% of the time has passed", () => {
		const before = render(SimulationClock, {
			props: { elapsedSeconds: 79, totalDurationSeconds: 100 },
		});
		expect(bar(before.container)).toHaveClass("bg-success");
		const after = render(SimulationClock, {
			props: { elapsedSeconds: 80, totalDurationSeconds: 100 },
		});
		expect(bar(after.container)).toHaveClass("bg-brand");
	});

	// Tests that the bar never grows past full width once time is up.
	it("caps the bar at 100%", () => {
		const { container } = render(SimulationClock, {
			props: { elapsedSeconds: 500, totalDurationSeconds: 100 },
		});
		expect(bar(container).style.width).toBe("100%");
		expect(screen.getByText("08:20 / 01:40")).toBeInTheDocument();
	});
});
