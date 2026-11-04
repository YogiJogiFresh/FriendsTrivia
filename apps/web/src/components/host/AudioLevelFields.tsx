import { useId } from 'react'
import { validAudioLevels } from '../../lib/audioLevels'
import type { AudioLevelInfo, AudioLevelSettings } from '../../lib/audioLevels'
import { Button, TextField } from '../common'
import styles from './AudioSnippetUploader.module.css'

export function AudioLevelFields({ label, value, levels, disabled, onChange }: {
  label: string
  value: AudioLevelSettings
  levels?: AudioLevelInfo
  disabled: boolean
  onChange: (value: AudioLevelSettings) => void
}) {
  const sliderId = useId()
  return (
    <div>
      <label className={styles.include}>
        <input type="checkbox" checked={value.normalize} disabled={disabled}
          onChange={(event) => onChange({ ...value, normalize: event.target.checked })} />
        {label} normalize volume
      </label>
      <TextField label={`${label} volume adjustment (dB)`} type="number" min={-12} max={12} step={0.5}
        value={Number.isFinite(value.gainDb) ? value.gainDb : ''} disabled={disabled}
        hint="Negative = quieter; positive = louder. Applied after normalization, with peak protection."
        error={!validAudioLevels(value) ? 'Enter -12 to +12 dB in half-dB steps.' : undefined}
        onChange={(event) => onChange({ ...value, gainDb: event.target.valueAsNumber })} />
      <label htmlFor={sliderId}>{label} volume adjustment slider</label>
      <input id={sliderId} className={styles.levelSlider} type="range" min={-12} max={12} step={0.5}
        value={Number.isFinite(value.gainDb) ? value.gainDb : 0} disabled={disabled}
        aria-valuetext={`${Number.isFinite(value.gainDb) ? value.gainDb : 0} dB`}
        onChange={(event) => onChange({ ...value, gainDb: event.target.valueAsNumber })} />
      <Button variant="ghost" className={styles.levelReset} disabled={disabled} onClick={() => onChange({ normalize: false, gainDb: 0 })}>
        Reset {label.toLowerCase()} volume
      </Button>
      {levels ? (
        <p role="status">
          {levels.inputDb === null ? 'Near-silence; automatic boost skipped.' : `Input average: ${levels.inputDb.toFixed(1)} dBFS.`}
          {' '}Requested gain: {levels.requestedDb.toFixed(1)} dB. Applied: {levels.appliedDb.toFixed(1)} dB.
          {levels.peakLimited ? ' Peak protection limited the adjustment.' : ''}
          {levels.boostLimited ? ' Total boost is limited to +12 dB.' : ''}
        </p>
      ) : <p>Optional approximate loudness matching, not LUFS mastering. Preview to hear the processed MP3.</p>}
    </div>
  )
}
