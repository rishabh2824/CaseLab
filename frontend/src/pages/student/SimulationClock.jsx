import { useEffect, useState } from 'react'

const formatTime = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// Ticks its own local state every second, isolated from the rest of student
// Home (message list, contacts, notes) so only this small widget re-renders
// as the simulation clock advances. The auto-end-on-expiry side effect lives
// in useSimulationRun, not here — this component is display-only.
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

    return (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Simulation Time
            </h3>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
                {formatTime(elapsedSeconds)} /{' '}
                {hasTotal ? formatTime(totalDurationSeconds) : '--:--'}
            </p>
            <div className="mt-3 h-2 rounded-full bg-slate-100">
                <div
                    className="h-2 rounded-full bg-emerald-500"
                    style={{ width: `${progressPercent}%` }}
                />
            </div>
        </div>
    )
}

export default SimulationClock
