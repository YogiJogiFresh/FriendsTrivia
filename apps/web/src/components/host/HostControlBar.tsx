import type { GamePhase } from '../../data/types'
import { Button } from '../common'
import styles from './HostControlBar.module.css'

export interface HostControlBarProps {
  phase: GamePhase
  hasCurrentClue?: boolean
  onGoBack?: () => void
  onResetClue?: () => void
  onCloseAnswers?: () => void
  onSkip?: () => void
  onReveal?: () => void
  onAdjustScore?: () => void
  onAdvance?: () => void
  onStartFinal?: () => void
}

/**
 * Host control toolbar. Buttons are enabled/disabled based on the current
 * game phase so the host can't, for example, "reveal" before answers close.
 */
export function HostControlBar({
  phase,
  hasCurrentClue = false,
  onGoBack,
  onResetClue,
  onCloseAnswers,
  onSkip,
  onReveal,
  onAdjustScore,
  onAdvance,
  onStartFinal,
}: HostControlBarProps) {
  const isLiveClue =
    phase === 'CLUE_READY' ||
    phase === 'ACCEPTING_ANSWERS' ||
    phase === 'FINAL_QUESTION' ||
    phase === 'ANSWERS_CLOSED'
  const canStartFinal = phase === 'BOARD' || phase === 'LEADERBOARD'
  const canReset = hasCurrentClue && phase !== 'FINAL_WAGER'

  return (
    <div className={styles.bar} role="toolbar" aria-label="Host controls">
      <div className={styles.row}>
        <Button variant="secondary" onClick={onGoBack} disabled={!hasCurrentClue}>
          Go Back
        </Button>
        <Button variant="secondary" onClick={onResetClue} disabled={!canReset}>
          Reset Clue
        </Button>
        <Button variant="danger" onClick={onSkip} disabled={!isLiveClue}>
          Skip/Void
        </Button>
        <Button
          variant="secondary"
          onClick={onCloseAnswers}
          disabled={phase !== 'ACCEPTING_ANSWERS' && phase !== 'FINAL_QUESTION'}
        >
          Close answers
        </Button>
      </div>
      <div className={styles.row}>
        <Button variant="secondary" onClick={onStartFinal} disabled={!canStartFinal}>
          Final Question
        </Button>
        <Button variant="secondary" onClick={onAdjustScore}>
          Adjust score
        </Button>
        <div className={styles.rightActions}>
          <Button variant="primary" onClick={onReveal} disabled={phase !== 'ANSWERS_CLOSED'}>
            Reveal Answer
          </Button>
          <Button
            variant="primary"
            onClick={onAdvance}
            disabled={phase !== 'REVEAL' && phase !== 'LEADERBOARD'}
          >
            Advance
          </Button>
        </div>
      </div>
    </div>
  )
}
