import { useMemo, useRef, useState } from 'react'
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
  submitted?: boolean
  /** Rejections retain the draft; success locks the answer. */
  onSubmit?: (submission: AnswerSubmission) => void | Promise<void>
}

type Phase = 'answering' | 'submitting' | 'submitted'

/**
 * Renders the correct control for a clue's type and drives the shared
 * single-submit flow: one accepted answer per player and clue attempt.
 */
export function AnswerPanel({ clue, disabled = false, submitted = false, onSubmit }: AnswerPanelProps) {
  const [phase, setPhase] = useState<Phase>('answering')
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const [priceValue, setPriceValue] = useState(() => (clue.type === 'price-slider' ? clue.min : 0))
  const [submitError, setSubmitError] = useState<string | null>(null)
  const pending = useRef(false)

  const hasAnswer = useMemo(() => {
    if (clue.type === 'music-multiple-choice') return selectedOptionId !== null
    if (clue.type === 'music-free-text') return freeText.trim().length > 0
    return true
  }, [clue.type, selectedOptionId, freeText])

  async function handleSubmitClick() {
    if (pending.current || disabled || submitted || !hasAnswer) return
    pending.current = true
    setSubmitError(null)
    setPhase('submitting')
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
      setPhase('answering')
    } finally { pending.current = false }
  }

  if (submitted || phase === 'submitted') {
    return (
      <p className={styles.submittedState} role="status">Submitted</p>
    )
  }

  const controlsDisabled = disabled || phase === 'submitting'
  return (
    <div className={styles.panel}>
      <p className={styles.prompt}>{clue.prompt}</p>

      {clue.type === 'music-multiple-choice' ? (
        <MultipleChoiceAnswer
          options={clue.options}
          selectedOptionId={selectedOptionId}
          onSelect={setSelectedOptionId}
          disabled={controlsDisabled}
        />
      ) : null}

      {clue.type === 'music-free-text' ? (
        <FreeTextAnswer value={freeText} onChange={setFreeText} disabled={controlsDisabled} />
      ) : null}

      {clue.type === 'price-slider' ? (
        <PriceSliderAnswer
          min={clue.min}
          max={clue.max}
          step={clue.step}
          value={priceValue}
          onChange={setPriceValue}
          unitPrefix={clue.unitPrefix}
          disabled={controlsDisabled}
        />
      ) : null}

      {submitError ? <p role="alert" className={styles.submitError}>{submitError}</p> : null}
      <div className={styles.actions}>
        <Button variant="primary" size="lg" fullWidth disabled={controlsDisabled || !hasAnswer} onClick={handleSubmitClick}>
          {phase === 'submitting' ? 'Submitting...' : 'Submit answer'}
        </Button>
      </div>
    </div>
  )
}
