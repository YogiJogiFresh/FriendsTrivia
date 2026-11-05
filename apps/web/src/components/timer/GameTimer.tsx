import styles from './GameTimer.module.css'

export interface GameTimerProps {
  secondsRemaining: number
  totalSeconds: number
  size?: 'display' | 'compact'
  paused?: boolean
  label?: string
  variant?: 'ring' | 'line'
}

/**
 * Countdown used on the shared display, host controls, and phone
 * clue screen. The server is the source of truth for `secondsRemaining` —
 * this component only renders whatever value it is given; it does not run
 * its own clock, so it cannot drift from the authoritative server timer.
 */
export function GameTimer({
  secondsRemaining,
  totalSeconds,
  size = 'compact',
  paused = false,
  label = 'Time remaining',
  variant = 'ring',
}: GameTimerProps) {
  const clampedTotal = Math.max(totalSeconds, 1)
  const clampedRemaining = Math.min(Math.max(secondsRemaining, 0), clampedTotal)
  const ratio = clampedRemaining / clampedTotal
  const urgency = ratio <= 0.2 ? 'danger' : ratio <= 0.5 ? 'warning' : 'safe'

  const radius = 42
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - ratio)

  const classes = [
    styles.timer,
    styles[size],
    variant === 'line' ? styles.line : '',
    paused ? styles.paused : styles[urgency],
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} role="timer" aria-label={`${label}: ${clampedRemaining} seconds${paused ? ', paused' : ''}`}>
      {variant === 'line' ? (
        <span className={styles.lineTrack} aria-hidden="true">
          <span className={styles.lineProgress} style={{ transform: `scaleX(${ratio})` }} />
        </span>
      ) : <svg className={styles.ring} viewBox="0 0 100 100" aria-hidden="true">
        <circle className={styles.track} cx="50" cy="50" r={radius} strokeWidth="8" />
        <circle
          className={styles.progress}
          cx="50"
          cy="50"
          r={radius}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>}
      <span className={styles.value} aria-hidden="true">
        {variant === 'line' ? `${clampedRemaining}s${paused ? ' (paused)' : ''}` : paused ? '⏸' : clampedRemaining}
      </span>
    </div>
  )
}
