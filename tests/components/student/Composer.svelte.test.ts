import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import Composer from "../../../src/lib/components/student/Composer.svelte";
import type { RunStore } from "../../../src/lib/student/run.svelte.js";

const NOW = 1_000_000;

// The run-store members the composer reads.
type ComposerRun = Pick<
	RunStore,
	| "isSending"
	| "activePersonaAvailable"
	| "timeExpired"
	| "activeContact"
	| "failedMessage"
	| "replySentAt"
	| "replyDeliverAt"
	| "sendMessage"
>;

// Renders the composer with a reply in flight that was sent and is due at the given times.
async function renderSending(
	replySentAt: number | null,
	replyDeliverAt: number | null,
) {
	const run: ComposerRun = $state({
		isSending: true,
		activePersonaAvailable: true,
		timeExpired: false,
		activeContact: null,
		failedMessage: null,
		replySentAt,
		replyDeliverAt,
		sendMessage: vi.fn(async () => true),
	});
	const screen = await render(Composer, { run: run as RunStore });
	return { run, screen };
}

// The circle that fills as the reply comes in (the first circle is the faint track behind it).
const ring = () =>
	document.querySelectorAll<SVGCircleElement>(
		'svg[aria-label="Sending"] circle',
	)[1]!;

// What the browser is animating the ring through right now: where it starts, where it ends and how long it takes.
function motion() {
	const animations = ring().getAnimations();
	expect(animations).toHaveLength(1);
	const animation = animations[0] as CSSTransition;
	const frames = (animation.effect as KeyframeEffect).getKeyframes();
	const timing = animation.effect!.getTiming();
	return {
		from: Number.parseFloat(String(frames.at(0)?.strokeDashoffset)),
		to: Number.parseFloat(String(frames.at(-1)?.strokeDashoffset)),
		duration: Number(timing.duration),
		easing: timing.easing,
	};
}

beforeEach(() => {
	// Only the clock the component reads and the crawl timer are faked. The browser runs CSS transitions on its own clock, so they stay real.
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("sending ring without a response delay", () => {
	// Tests that the ring fills quickly to 90%, then crawls slowly towards 97% so it never looks finished early.
	it("fills to 90% over four seconds, then crawls to 97% after that", async () => {
		await renderSending(NOW, null);

		expect(motion()).toMatchObject({ from: 100, to: 10, duration: 4000 });

		vi.advanceTimersByTime(3_999);
		expect(motion().to).toBe(10);

		vi.advanceTimersByTime(1);
		expect(motion()).toMatchObject({
			to: 3,
			duration: 30_000,
			easing: "linear",
		});
	});

	// Tests that a delay no longer than the quick fill uses the ordinary ring.
	it("treats a short delay like no delay", async () => {
		await renderSending(NOW, NOW + 4_000);

		expect(motion()).toMatchObject({ to: 10, duration: 4000 });
	});

	// Tests that the slow crawl is cancelled when the reply lands first.
	it("stops the crawl when the reply arrives", async () => {
		const { run } = await renderSending(NOW, null);
		const firstRing = ring();

		run.isSending = false;
		await expect
			.element(page.getByLabelText("Sending"))
			.not.toBeInTheDocument();
		vi.advanceTimersByTime(4_000);

		expect(firstRing.style.transitionDuration).not.toBe("30000ms");
	});
});

describe("sending ring for a delayed reply", () => {
	// Tests that a fresh delayed reply starts empty and fills evenly to 97% exactly when it is due.
	it("fills evenly over the whole delay", async () => {
		await renderSending(NOW, NOW + 30_000);

		expect(motion()).toMatchObject({
			from: 100,
			to: 3,
			duration: 30_000,
			easing: "linear",
		});
	});

	// Tests that after a reload part-way through the delay the ring resumes from where it would have been.
	it("resumes part-way after a reload", async () => {
		await renderSending(NOW - 10_000, NOW + 10_000);

		expect(motion()).toMatchObject({
			from: 51.5,
			to: 3,
			duration: 10_000,
			easing: "linear",
		});
	});

	// Tests that a reply already past its due time shows a nearly full ring rather than an animation.
	it("shows a nearly full ring once the reply is overdue", async () => {
		await renderSending(NOW - 30_000, NOW - 5_000);

		expect(ring().getAnimations()).toHaveLength(0);
		expect(getComputedStyle(ring()).strokeDashoffset).toBe("3px");
	});
});
