import type { ClueOption } from '../../data/types'
import styles from './MultipleChoiceAnswer.module.css'

export interface MultipleChoiceAnswerProps {
  options: ClueOption[]
  selectedOptionId: string | null
  onSelect: (optionId: string) => void
  disabled?: boolean
  /** When set (post-reveal), colors the correct option green and any wrong pick red. */
  revealCorrectOptionId?: string
}

export function MultipleChoiceAnswer({
  options,
  selectedOptionId,
  onSelect,
  disabled = false,
  revealCorrectOptionId,
}: MultipleChoiceAnswerProps) {
  return (
    <div className={styles.grid} role="radiogroup" aria-label="Answer choices">
      {options.map((option) => {
        const isSelected = option.id === selectedOptionId
        const isRevealed = revealCorrectOptionId !== undefined
        const isCorrect = isRevealed && option.id === revealCorrectOptionId
        const isIncorrectPick = isRevealed && isSelected && option.id !== revealCorrectOptionId

        const classes = [
          styles.option,
          isSelected && !isRevealed ? styles.optionSelected : '',
          isCorrect ? styles.optionCorrect : '',
          isIncorrectPick ? styles.optionIncorrect : '',
        ]
          .filter(Boolean)
          .join(' ')

        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={classes}
            disabled={disabled}
            onClick={() => onSelect(option.id)}
          >
            {option.label}
            {isCorrect ? <span className="visually-hidden"> (correct answer)</span> : null}
          </button>
        )
      })}
    </div>
  )
}
