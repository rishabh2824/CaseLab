import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import SimulationClock from "../../../src/lib/components/student/SimulationClock.svelte";

// The progress bar: the one element with an inline width.
const bar = () => page.elementLocator(document.querySelector("[style]")!);

describe("SimulationClock", () => {
	// Tests that elapsed and total time are formatted as MM:SS.
	it("shows elapsed and total time as MM:SS", async () => {
		await render(SimulationClock, {
			elapsedSeconds: 65,
			totalDurationSeconds: 600,
		});
		await expect.element(page.getByText("01:05 / 10:00")).toBeInTheDocument();
	});

	// Tests that an unlimited simulation shows a placeholder total and an empty bar.
	it("shows --:-- and an empty bar when there is no duration", async () => {
		await render(SimulationClock, {
			elapsedSeconds: 30,
			totalDurationSeconds: null,
		});
		await expect.element(page.getByText("00:30 / --:--")).toBeInTheDocument();
		await expect.element(bar()).toHaveStyle({ width: "0%" });
	});

	// Tests that the bar is green until 80% and turns to the brand colour after.
	it("switches the bar colour once 80% of the time has passed", async () => {
		const before = await render(SimulationClock, {
			elapsedSeconds: 79,
			totalDurationSeconds: 100,
		});
		await expect.element(bar()).toHaveClass("bg-success");
		before.unmount();

		await render(SimulationClock, {
			elapsedSeconds: 80,
			totalDurationSeconds: 100,
		});
		await expect.element(bar()).toHaveClass("bg-brand");
	});

	// Tests that the bar never grows past full width once time is up.
	it("caps the bar at 100%", async () => {
		await render(SimulationClock, {
			elapsedSeconds: 500,
			totalDurationSeconds: 100,
		});
		await expect.element(bar()).toHaveStyle({ width: "100%" });
		await expect.element(page.getByText("08:20 / 01:40")).toBeInTheDocument();
	});
});
