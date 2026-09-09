import type { ChangeEvent } from 'react'
import styles from './PriceSliderAnswer.module.css'

export interface PriceSliderAnswerProps {
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  unitPrefix?: string
  disabled?: boolean
}

/**
 * Mobile-friendly price guess control. The range slider is the primary
 * input; +/- buttons are provided alongside it so players who need finer
 * control (or who use switch/keyboard access) are not limited to dragging.
 */
export function PriceSliderAnswer({
  min,
  max,
  step,
  value,
  onChange,
  unitPrefix = '$',
  disabled = false,
}: PriceSliderAnswerProps) {
  function clamp(next: number) {
    return Math.min(max, Math.max(min, next))
  }

  function handleSliderChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(clamp(Number(event.target.value)))
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.readout}>
        <button
          type="button"
          className={styles.stepButton}
          aria-label={`Decrease by ${step}`}
          disabled={disabled || value <= min}
          onClick={() => onChange(clamp(value - step))}
        >
          −
        </button>
        <span className={styles.value} aria-live="polite">
          {unitPrefix}
          {value.toLocaleString()}
        </span>
        <button
          type="button"
          className={styles.stepButton}
          aria-label={`Increase by ${step}`}
          disabled={disabled || value >= max}
          onClick={() => onChange(clamp(value + step))}
        >
          +
        </button>
      </div>
      <input
        className={styles.slider}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleSliderChange}
        disabled={disabled}
        aria-label="Price guess"
        aria-valuetext={`${unitPrefix}${value.toLocaleString()}`}
      />
      <div className={styles.bounds} aria-hidden="true">
        <span>
          {unitPrefix}
          {min.toLocaleString()}
        </span>
        <span>
          {unitPrefix}
          {max.toLocaleString()}
        </span>
      </div>
    </div>
  )
}
