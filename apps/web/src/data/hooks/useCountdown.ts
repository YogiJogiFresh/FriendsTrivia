import { useEffect, useState } from 'react'

function computeRemaining(deadline: string | undefined, fallbackSeconds: number): number {
  if (!deadline) return fallbackSeconds
  const remainingMs = Date.parse(deadline) - Date.now()
  return Math.max(0, Math.ceil(remainingMs / 1000))
}

/**
 * Reads down from the server's authoritative `deadline` timestamp. This
 * only ever recomputes "now vs. deadline" on an interval — it never
 * accumulates its own elapsed time — so it cannot drift from the server,
 * and immediately re-syncs whenever a new snapshot changes `deadline`.
 */
export function useCountdown(deadline: string | undefined, fallbackSeconds: number): number {
  const [secondsRemaining, setSecondsRemaining] = useState(() => computeRemaining(deadline, fallbackSeconds))

  useEffect(() => {
    setSecondsRemaining(computeRemaining(deadline, fallbackSeconds))
    if (!deadline) return undefined
    const interval = window.setInterval(() => {
      setSecondsRemaining(computeRemaining(deadline, fallbackSeconds))
    }, 250)
    return () => window.clearInterval(interval)
  }, [deadline, fallbackSeconds])

  return secondsRemaining
}
