import type { ConnectionState } from '../../data/types'
import styles from './ConnectionStatus.module.css'

export interface ConnectionStatusProps {
  status: ConnectionState
}

const labels: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
}

/** Compact status pill for headers (shared display, host controls, phone). */
export function ConnectionStatusPill({ status }: ConnectionStatusProps) {
  return (
    <span className={styles.pill} role="status">
      <span className={[styles.dot, styles[status]].join(' ')} aria-hidden="true" />
      {labels[status]}
    </span>
  )
}

/**
 * Full-width banner shown whenever the connection is not in the "connected"
 * state, so players and the host always know when actions may not reach the
 * server. Announced via `aria-live` for screen reader users.
 */
export function ReconnectBanner({ status }: ConnectionStatusProps) {
  if (status === 'connected') {
    return null
  }

  const message =
    status === 'offline'
      ? 'Connection lost. Trying to reconnect… your answers will not be sent until this reconnects.'
      : status === 'reconnecting'
        ? 'Reconnecting to the game…'
        : 'Connecting to the game…'

  return (
    <div className={[styles.banner, styles[status]].join(' ')} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}
