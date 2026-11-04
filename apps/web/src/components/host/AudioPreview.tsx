import { useEffect, useRef, useState } from 'react'
import { Button } from '../common'
import { createAudioPlayback, playbackSettings, validPlayback } from '../../lib/audioPlayback'
import type { AudioPlaybackSettings, PlaybackState } from '../../lib/audioPlayback'
import styles from './AudioPreview.module.css'

let stopCurrentPreview: (() => void) | undefined

interface AudioPreviewProps {
  src: string
  label: string
  settings?: AudioPlaybackSettings
  reveal?: boolean
  active?: boolean
}

export function AudioPreview(props: AudioPreviewProps) {
  const settings = playbackSettings(props.settings, props.reveal)
  return props.active === false ? null : (
    <AudioPreviewPlayer key={`${props.src}-${settings.delaySeconds}-${settings.playCount}`} {...props} />
  )
}

function AudioPreviewPlayer({ src, label, settings: input, reveal = false, active = true }: AudioPreviewProps) {
  const settings = playbackSettings(input, reveal)
  const { delaySeconds, playCount } = settings
  const audioRef = useRef<HTMLAudioElement>(null)
  const playbackRef = useRef<ReturnType<typeof createAudioPlayback> | null>(null)
  const [state, setState] = useState<PlaybackState>('idle')
  const [plays, setPlays] = useState(0)
  const [failed, setFailed] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const valid = validPlayback(settings)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !active || !valid) return
    audio.src = src
    const playback = createAudioPlayback(audio, { delaySeconds, playCount }, {
      onState: (next, count) => { setState(next); setPlays(count) },
      onError: () => setFailed(true),
    })
    playbackRef.current = playback
    return () => {
      if (stopCurrentPreview === playback.stop) stopCurrentPreview = undefined
      playback.dispose()
      playbackRef.current = null
      audio.removeAttribute('src')
      audio.load()
    }
  }, [src, active, valid, delaySeconds, playCount])

  function play() {
    const playback = playbackRef.current
    if (!playback) return
    if (stopCurrentPreview !== playback.stop) stopCurrentPreview?.()
    stopCurrentPreview = playback.stop
    setFailed(false)
    if (state === 'paused' && !failed) playback.resume()
    else playback.start()
  }

  return (
    <div className={styles.player}>
      <strong>{label}</strong>
      <audio ref={audioRef} preload="none" aria-label={label}
        onTimeUpdate={() => setPosition(audioRef.current?.currentTime ?? 0)}
        onDurationChange={() => setDuration(audioRef.current?.duration ?? 0)} />
      <div className={styles.controls}>
        <Button variant="secondary" disabled={!active || !valid || state === 'playing' || state === 'waiting'}
          onClick={play}>{state === 'paused' ? `Resume ${label.toLowerCase()}` : `Play ${label.toLowerCase()}`}</Button>
        <Button variant="secondary" disabled={state !== 'playing' && state !== 'waiting'}
          onClick={() => playbackRef.current?.pause()}>Pause</Button>
        <Button variant="ghost" onClick={() => playbackRef.current?.stop()}>Stop</Button>
      </div>
      {Number.isFinite(duration) && duration > 0 ? (
        <input type="range" min={0} max={duration} step={0.1} value={Math.min(position, duration)}
          aria-label={`${label} position`} onChange={(event) => {
            if (audioRef.current) audioRef.current.currentTime = event.target.valueAsNumber
            setPosition(event.target.valueAsNumber)
          }} />
      ) : null}
      <span role="status" className={styles.status}>
        {state === 'waiting' ? `Waiting ${settings.delaySeconds} seconds before playback.`
          : state === 'playing' ? `Playing ${plays}${settings.playCount ? ` of ${settings.playCount}` : ' (looping)'}.`
            : state === 'finished' ? 'Playback finished.' : state === 'paused' ? 'Playback paused.' : 'Manual preview; uses delay and play count settings.'}
      </span>
      {!valid ? <p role="alert">Fix the delay or play count before previewing.</p> : null}
      {failed ? <p role="alert">Could not play this clip. Check its attachment or browser audio permissions.</p> : null}
    </div>
  )
}
