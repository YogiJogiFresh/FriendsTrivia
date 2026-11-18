import type { Player } from '../../data/types'
import styles from './AnsweredPlayers.module.css'

export function AnsweredPlayers({ players, connected, progress }: {
  players: Player[]
  connected: boolean
  progress?: { answered: number; total: number }
}) {
  const answered = players.filter(player => player.hasAnsweredCurrentClue)
  return (
    <div className={styles.status}>
      <p role="status" aria-atomic="true">{connected
        ? `${answered.length}${progress ? `/${progress.total}` : ''} players answered`
        : 'Answer status unavailable while reconnecting.'}</p>
      {connected && answered.length > 0
        ? <p className={styles.names}>Answered: {answered.map(player => player.nickname).join(', ')}</p>
        : null}
    </div>
  )
}
