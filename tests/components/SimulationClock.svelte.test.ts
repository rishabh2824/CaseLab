import { render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SimulationClock from "../../src/lib/components/SimulationClock.svelte";

const NOW = new Date("2026-01-01T12:00:00Z").getTime();

// Returns the progress bar element.
function bar(container: HTMLElement): HTMLElement {
	return container.querySelector("[style]") as HTMLElement;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("SimulationClock", () => {
	// Tests that elapsed time is measured from the start time and formatted as MM:SS.
	it("shows elapsed and total time as MM:SS", () => {
		render(SimulationClock, {
			props: { startTime: NOW - 65_000, totalDurationSeconds: 600 },
		});
		expect(screen.getByText("01:05 / 10:00")).toBeInTheDocument();
	});

	// Tests that the clock advances each second.
	it("ticks forward every second", async () => {
		render(SimulationClock, {
			props: { startTime: NOW, totalDurationSeconds: 600 },
		});
		expect(screen.getByText("00:00 / 10:00")).toBeInTheDocument();
		await vi.advanceTimersByTimeAsync(3000);
		expect(screen.getByText("00:03 / 10:00")).toBeInTheDocument();
	});

	// Tests that an unlimited simulation shows a placeholder total and an empty bar.
	it("shows --:-- and an empty bar when there is no duration", () => {
		const { container } = render(SimulationClock, {
			props: { startTime: NOW - 30_000, totalDurationSeconds: null },
		});
		expect(screen.getByText("00:30 / --:--")).toBeInTheDocument();
		expect(bar(container).style.width).toBe("0%");
	});

	// Tests that a missing start time counts from now.
	it("counts from now when the start time is unknown", () => {
		render(SimulationClock, {
			props: { startTime: null, totalDurationSeconds: 600 },
		});
		expect(screen.getByText("00:00 / 10:00")).toBeInTheDocument();
	});

	// Tests that a start time in the future never shows negative time.
	it("clamps a future start time to zero", () => {
		render(SimulationClock, {
			props: { startTime: NOW + 60_000, totalDurationSeconds: 600 },
		});
		expect(screen.getByText("00:00 / 10:00")).toBeInTheDocument();
	});

	// Tests that the bar is green until 80% and turns to the brand colour after.
	it("switches the bar colour once 80% of the time has passed", () => {
		const before = render(SimulationClock, {
			props: { startTime: NOW - 79_000, totalDurationSeconds: 100 },
		});
		expect(bar(before.container)).toHaveClass("bg-success");
		const after = render(SimulationClock, {
			props: { startTime: NOW - 80_000, totalDurationSeconds: 100 },
		});
		expect(bar(after.container)).toHaveClass("bg-brand");
	});

	// Tests that the bar never grows past full width once time is up.
	it("caps the bar at 100%", () => {
		const { container } = render(SimulationClock, {
			props: { startTime: NOW - 500_000, totalDurationSeconds: 100 },
		});
		expect(bar(container).style.width).toBe("100%");
		expect(screen.getByText("08:20 / 01:40")).toBeInTheDocument();
	});

	// Tests that unmounting stops the interval so it cannot leak.
	it("clears its interval on unmount", () => {
		const { unmount } = render(SimulationClock, {
			props: { startTime: NOW, totalDurationSeconds: 600 },
		});
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
