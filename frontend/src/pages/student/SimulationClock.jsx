import { useEffect, useState } from 'react'

const formatTime = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// Ticks its own local state every second, isolated from the rest of student Home so only this small widget re-renders
// The auto-end-on-expiry side effect lives in useSimulationRun
function SimulationClock({ startTime, totalDurationSeconds }) {
    const [elapsedSeconds, setElapsedSeconds] = useState(0)

    useEffect(() => {
        const start = startTime ?? Date.now()
        const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)))
        tick()
        const intervalId = window.setInterval(tick, 1000)
        return () => window.clearInterval(intervalId)
    }, [startTime])

    const hasTotal = typeof totalDurationSeconds === 'number'
    const progressPercent = hasTotal
        ? Math.min(100, (elapsedSeconds / totalDurationSeconds) * 100)
        : 0

    // Warn as time runs low: the bar shifts to Wisconsin red past 80% elapsed.
    const isRunningLow = progressPercent >= 80

    return (
        <div className="rounded-2xl border border-line bg-white p-4 shadow-soft">
            <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-stone-soft">
                Simulation Time
            </h3>
            <p className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink tabular-nums">
                {formatTime(elapsedSeconds)} /{' '}
                {hasTotal ? formatTime(totalDurationSeconds) : '--:--'}
            </p>
            <div className="mt-3 h-2 rounded-full bg-line-soft">
                <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                        isRunningLow ? 'bg-brand' : 'bg-success'
                    }`}
                    style={{ width: `${progressPercent}%` }}
                />
            </div>
        </div>
    )
}

export default SimulationClock
