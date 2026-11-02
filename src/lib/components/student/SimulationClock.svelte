<script lang="ts">
type Props = {
	elapsedSeconds: number;
	totalDurationSeconds: number | null;
};

let { elapsedSeconds, totalDurationSeconds }: Props = $props();

// Formats a number of seconds as MM:SS.
function formatTime(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const progressPercent = $derived(
	typeof totalDurationSeconds === "number"
		? Math.min(100, (elapsedSeconds / totalDurationSeconds) * 100)
		: 0,
);
const isRunningLow = $derived(progressPercent >= 80);
</script>

<div class="rounded-2xl border border-line bg-white p-4 shadow-soft">
	<h3 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">Simulation Time</h3>
	<p class="mt-2 font-display text-2xl font-semibold tracking-tight text-ink tabular-nums">
		{formatTime(elapsedSeconds)} / {typeof totalDurationSeconds === 'number' ? formatTime(totalDurationSeconds) : '--:--'}
	</p>
	<div class="mt-3 h-2 rounded-full bg-line-soft">
		<div
			class="h-2 rounded-full transition-all duration-500 {isRunningLow ? 'bg-brand' : 'bg-success'}"
			style="width: {progressPercent}%"
		></div>
	</div>
</div>
