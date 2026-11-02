<script lang="ts">
import SimulationClock from "#lib/components/student/SimulationClock.svelte";
import type { RunStore } from "#lib/student/run.svelte.js";

let { run }: { run: RunStore } = $props();
</script>

<aside class="space-y-4">
	<div class="rounded-2xl border border-line bg-white p-4 shadow-soft">
		<h3 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">Case Brief</h3>
		<p class="mt-2 text-sm leading-relaxed text-stone">{run.caseData?.brief ?? 'Loading brief...'}</p>
	</div>

	<SimulationClock elapsedSeconds={run.elapsedSeconds} totalDurationSeconds={run.totalDurationSeconds} />

	<div class="rounded-2xl border border-line bg-white p-4 shadow-soft">
		<h3 class="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">Your Notes</h3>
		<textarea
			aria-label="Your notes"
			class="mt-3 h-40 w-full resize-none rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink-soft transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/12"
			placeholder="Write your notes here..."
			value={run.notes}
			oninput={(event) => run.setNotes(event.currentTarget.value)}
		></textarea>
	</div>
</aside>
