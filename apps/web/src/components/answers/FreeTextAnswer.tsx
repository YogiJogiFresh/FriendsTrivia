import { useId } from 'react'
import type { ChangeEvent } from 'react'
import styles from './FreeTextAnswer.module.css'

export interface FreeTextAnswerProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  maxLength?: number
  placeholder?: string
}

export function FreeTextAnswer({
  value,
  onChange,
  disabled = false,
  maxLength = 60,
  placeholder = 'Type your answer…',
}: FreeTextAnswerProps) {
  const inputId = useId()

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.value.slice(0, maxLength))
  }

  return (
    <div className={styles.form}>
      <label className="visually-hidden" htmlFor={inputId}>
        Your answer
      </label>
      <input
        id={inputId}
        className={styles.input}
        type="text"
        value={value}
        onChange={handleChange}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
      />
      <span className={styles.count} aria-live="polite">
        {value.length}/{maxLength}
      </span>
    </div>
  )
}
