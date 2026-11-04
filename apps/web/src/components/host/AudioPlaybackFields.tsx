import { TextField } from '../common'
import { playbackSettings } from '../../lib/audioPlayback'
import type { AudioPlaybackSettings } from '../../lib/audioPlayback'

export function AudioPlaybackFields({ value, reveal = false, onChange }: {
  value: AudioPlaybackSettings | undefined
  reveal?: boolean
  onChange: (value: AudioPlaybackSettings) => void
}) {
  const settings = playbackSettings(value, reveal)
  return (
    <>
      <TextField label={reveal ? 'Reveal delay (seconds)' : 'Song delay (seconds)'} type="number" min={0} max={300} step={1}
        value={Number.isFinite(settings.delaySeconds) ? settings.delaySeconds : ''}
        hint="0-300 whole seconds. Wait before the first play and between repeats."
        error={!Number.isInteger(settings.delaySeconds) || settings.delaySeconds < 0 || settings.delaySeconds > 300 ? 'Enter a whole number from 0 to 300.' : undefined}
        onChange={(event) => onChange({ ...settings, delaySeconds: event.target.valueAsNumber })} />
      <TextField label={reveal ? 'Reveal play count' : 'Song play count'} type="number" min={0} max={100} step={1}
        value={Number.isFinite(settings.playCount) ? settings.playCount : ''}
        hint="Total plays: 1 = once, 2 = twice, 0 = loop until stopped. Maximum 100."
        error={!Number.isInteger(settings.playCount) || settings.playCount < 0 || settings.playCount > 100 ? 'Enter a whole number from 0 to 100.' : undefined}
        onChange={(event) => onChange({ ...settings, playCount: event.target.valueAsNumber })} />
    </>
  )
}
