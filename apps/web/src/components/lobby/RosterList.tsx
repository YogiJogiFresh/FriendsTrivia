import type { Player } from '../../data/types'
import { Badge } from '../common'
import styles from './RosterList.module.css'

export interface RosterListProps {
  players: Player[]
  /** Host mode: shows a kick action per player. */
  onKickPlayer?: (playerId: string) => void
}

export function RosterList({ players, onKickPlayer }: RosterListProps) {
  if (players.length === 0) {
    return <p className={styles.empty}>No players have joined yet.</p>
  }

  return (
    <ul className={styles.list} aria-label="Players in this room">
      {players.map((player) => (
        <li
          key={player.id}
          className={[styles.row, player.connected ? '' : styles.rowDisconnected].filter(Boolean).join(' ')}
        >
          <span className={styles.identity}>
            <span
              className={[styles.presenceDot, player.connected ? styles.online : styles.offline].join(' ')}
              aria-hidden="true"
            />
            <span className={styles.nickname}>{player.nickname}</span>
            {player.teamName ? <Badge tone="info">{player.teamName}</Badge> : null}
            {player.isHost ? <Badge tone="info">Host</Badge> : null}
          </span>
          <span className={styles.actions}>
            {!player.connected ? (
              <Badge tone="neutral">Reconnecting…</Badge>
            ) : player.hasAnsweredCurrentClue ? (
              <Badge tone="success">Answered</Badge>
            ) : null}
            {onKickPlayer && !player.isHost ? (
              <button
                type="button"
                className={styles.kickButton}
                onClick={() => onKickPlayer(player.id)}
                aria-label={`Remove ${player.nickname} from the room`}
              >
                Remove
              </button>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
