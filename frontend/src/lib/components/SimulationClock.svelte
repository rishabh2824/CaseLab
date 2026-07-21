<script lang="ts">
	type Props = {
		startTime: number | null
		totalDurationSeconds: number | null
	}

	let { startTime, totalDurationSeconds }: Props = $props()

	let elapsedSeconds = $state(0)

	function formatTime(totalSeconds: number): string {
		const minutes = Math.floor(totalSeconds / 60)
		const seconds = totalSeconds % 60
		return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
	}

	$effect(() => {
		const start = startTime ?? Date.now()
		const tick = () => {
			elapsedSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000))
		}
		tick()
		const intervalId = window.setInterval(tick, 1000)
		return () => window.clearInterval(intervalId)
	})

	// `number | null` can't narrow through a separately-stored boolean derived,
	// so the type check is inlined at each point totalDurationSeconds is
	// actually used — same runtime condition as the old `hasTotal`, just
	// re-checked at each site instead of read from one shared derived.
	const progressPercent = $derived(
		typeof totalDurationSeconds === 'number' ? Math.min(100, (elapsedSeconds / totalDurationSeconds) * 100) : 0,
	)
	// Warn as time runs low: the bar shifts to Wisconsin red past 80% elapsed.
	const isRunningLow = $derived(progressPercent >= 80)
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
