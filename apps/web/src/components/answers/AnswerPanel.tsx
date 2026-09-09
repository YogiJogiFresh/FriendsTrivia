import { useMemo, useState } from 'react'
import type { Clue } from '../../data/types'
import { Button } from '../common'
import { FreeTextAnswer } from './FreeTextAnswer'
import { MultipleChoiceAnswer } from './MultipleChoiceAnswer'
import { PriceSliderAnswer } from './PriceSliderAnswer'
import styles from './AnswerPanel.module.css'

export interface AnswerSubmission {
  clueId: string
  /**
   * The exact value sent to the server's `player:answer` event: the
   * selected option's label text for multiple choice (the server matches
   * against `config.correctAnswer` by string, not an id), the free-text
   * string as typed, or the numeric price for price-slider clues.
   */
  answer: string | number
}

export interface AnswerPanelProps {
  clue: Clue
  /** True while answers are closed, the round is paused, or the connection is down. */
  disabled?: boolean
  /** May reject (e.g. server ack error) — the panel then returns to the confirm step so the player can retry. */
  onSubmit?: (submission: AnswerSubmission) => void | Promise<void>
}

type Phase = 'answering' | 'confirming' | 'submitted'

/**
 * Renders the correct control for a clue's type and drives the shared
 * answer/confirm/submitted flow described in the plan: one accepted
 * submission per player, with an explicit confirmation step before it locks.
 */
export function AnswerPanel({ clue, disabled = false, onSubmit }: AnswerPanelProps) {
  const [phase, setPhase] = useState<Phase>('answering')
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const [priceValue, setPriceValue] = useState(() => (clue.type === 'price-slider' ? clue.min : 0))
  const [submitError, setSubmitError] = useState<string | null>(null)

  const hasAnswer = useMemo(() => {
    if (clue.type === 'music-multiple-choice') return selectedOptionId !== null
    if (clue.type === 'music-free-text') return freeText.trim().length > 0
    return true
  }, [clue.type, selectedOptionId, freeText])

  const summaryLabel = useMemo(() => {
    if (clue.type === 'music-multiple-choice') {
      return clue.options.find((option) => option.id === selectedOptionId)?.label ?? ''
    }
    if (clue.type === 'music-free-text') return freeText
    return `${clue.unitPrefix ?? '$'}${priceValue.toLocaleString()}`
  }, [clue, selectedOptionId, freeText, priceValue])

  function handleSubmitClick() {
    setSubmitError(null)
    setPhase('confirming')
  }

  async function handleConfirm() {
    const answer: string | number =
      clue.type === 'music-multiple-choice'
        ? clue.options.find((option) => option.id === selectedOptionId)?.label ?? ''
        : clue.type === 'music-free-text'
          ? freeText
          : priceValue
    try {
      await onSubmit?.({ clueId: clue.id, answer })
      setPhase('submitted')
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not submit that answer.')
      setPhase('confirming')
    }
  }

  if (phase === 'submitted') {
    return (
      <div className={styles.submittedState} role="status">
        <span className={styles.submittedIcon} aria-hidden="true">
          ✓
        </span>
        <span className={styles.submittedTitle}>Answer locked in!</span>
        <span className={styles.submittedHint}>Waiting for other players…</span>
      </div>
    )
  }

  if (phase === 'confirming') {
    return (
      <div className={styles.panel}>
        <div className={styles.confirmSummary}>
          <span className={styles.confirmLabel}>Submit this answer?</span>
          <span className={styles.confirmValue}>{summaryLabel || '—'}</span>
        </div>
        {submitError ? (
          <p role="alert" className={styles.submitError}>
            {submitError}
          </p>
        ) : null}
        <div className={styles.confirmButtons}>
          <Button variant="secondary" size="lg" onClick={() => setPhase('answering')}>
            Change answer
          </Button>
          <Button variant="primary" size="lg" onClick={handleConfirm}>
            Confirm
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <p className={styles.prompt}>{clue.prompt}</p>

      {clue.type === 'music-multiple-choice' ? (
        <MultipleChoiceAnswer
          options={clue.options}
          selectedOptionId={selectedOptionId}
          onSelect={setSelectedOptionId}
          disabled={disabled}
        />
      ) : null}

      {clue.type === 'music-free-text' ? (
        <FreeTextAnswer value={freeText} onChange={setFreeText} disabled={disabled} />
      ) : null}

      {clue.type === 'price-slider' ? (
        <PriceSliderAnswer
          min={clue.min}
          max={clue.max}
          step={clue.step}
          value={priceValue}
          onChange={setPriceValue}
          unitPrefix={clue.unitPrefix}
          disabled={disabled}
        />
      ) : null}

      <div className={styles.actions}>
        <Button variant="primary" size="lg" fullWidth disabled={disabled || !hasAnswer} onClick={handleSubmitClick}>
          Submit answer
        </Button>
      </div>
    </div>
  )
}
