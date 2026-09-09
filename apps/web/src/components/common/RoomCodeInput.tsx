import { useId } from 'react'
import type { ChangeEvent } from 'react'
import styles from './RoomCodeInput.module.css'

export interface RoomCodeInputProps {
  value: string
  onChange: (value: string) => void
  length?: number
  label?: string
  error?: string
  id?: string
}

/**
 * A single, large, centered input for entering/displaying a room code.
 * A single field (rather than one box per character) keeps the interaction
 * simple and reliable for one-thumb mobile use, while the styling still
 * reads as a distinct "code" input.
 */
export function RoomCodeInput({
  value,
  onChange,
  length = 4,
  label = 'Room code',
  error,
  id,
}: RoomCodeInputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, length)
    onChange(next)
  }

  return (
    <div className={styles.wrapper}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={[styles.input, error ? styles.inputError : ''].filter(Boolean).join(' ')}
        value={value}
        onChange={handleChange}
        placeholder={'-'.repeat(length)}
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        maxLength={length}
        aria-describedby={error ? errorId : hintId}
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      ) : (
        <span id={hintId} className={styles.hint}>
          Ask the host for the {length}-character room code.
        </span>
      )}
    </div>
  )
}
