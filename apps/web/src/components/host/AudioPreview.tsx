import { useEffect, useRef, useState } from 'react'
import { Button } from '../common'
import { createAudioPlayback, playbackSettings, validPlayback } from '../../lib/audioPlayback'
import type { AudioPlaybackSettings, PlaybackState } from '../../lib/audioPlayback'
import styles from './AudioPreview.module.css'

let stopCurrentPreview: (() => void) | undefined

interface AudioPreviewProps {
  src: string
  playlist?: readonly string[]
  label: string
  settings?: AudioPlaybackSettings
  reveal?: boolean
  active?: boolean
}

export function AudioPreview(props: AudioPreviewProps) {
  const settings = playbackSettings(props.settings, props.reveal)
  return props.active === false ? null : (
    <AudioPreviewPlayer key={JSON.stringify([props.src, props.playlist, settings.delaySeconds, settings.playCount])} {...props} />
  )
}

function AudioPreviewPlayer({ src, playlist, label, settings: input, reveal = false, active = true }: AudioPreviewProps) {
  const settings = playbackSettings(input, reveal)
  const { delaySeconds, playCount } = settings
  const audioRef = useRef<HTMLAudioElement>(null)
  // The wrapper remounts this player whenever the ordered source values change.
  const playlistRef = useRef(playlist)
  const playbackRef = useRef<ReturnType<typeof createAudioPlayback> | null>(null)
  const [state, setState] = useState<PlaybackState>('idle')
  const [plays, setPlays] = useState(0)
  const [track, setTrack] = useState(0)
  const [failed, setFailed] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const valid = validPlayback(settings)
  const canSeek = Number.isFinite(duration) && duration > 0

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !active || !valid) return
    audio.src = src
    const playback = createAudioPlayback(audio, { delaySeconds, playCount }, {
      playlist: playlistRef.current,
      onTrack: (index) => { setTrack(index); setPosition(0); setDuration(0) },
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
        <Button variant="secondary" disabled={!active || !valid || state === 'playing' || state === 'waiting' || state === 'starting'}
          onClick={play}>{state === 'paused' ? `Resume ${label.toLowerCase()}` : `Play ${label.toLowerCase()}`}</Button>
        <Button variant="secondary" disabled={state !== 'playing' && state !== 'waiting' && state !== 'starting'}
          onClick={() => playbackRef.current?.pause()}>Pause</Button>
        <Button variant="ghost" onClick={() => playbackRef.current?.stop()}>Stop</Button>
      </div>
      {playlist || canSeek ? (
        <input type="range" min={0} max={canSeek ? duration : 1} step={0.1}
          value={canSeek ? Math.min(position, duration) : 0} disabled={!canSeek}
          aria-label={`${label} position`} onChange={(event) => {
            if (audioRef.current) audioRef.current.currentTime = event.target.valueAsNumber
            setPosition(event.target.valueAsNumber)
          }} />
      ) : null}
      <span role="status" className={playlist ? `${styles.status} ${styles.playlistStatus}` : styles.status}>
        {playlist ? `Track ${track + 1} of ${playlist.length}. ` : ''}
        {state === 'starting' ? 'Preparing audio...'
          : state === 'waiting' ? `Waiting ${settings.delaySeconds} seconds before playback.`
          : state === 'playing' ? `Playing ${plays}${settings.playCount ? ` of ${settings.playCount}` : ' (looping)'}.`
            : state === 'finished' ? 'Playback finished.' : state === 'paused' ? 'Playback paused.' : 'Manual preview; uses delay and play count settings.'}
      </span>
      {!valid ? <p role="alert">Fix the delay or play count before previewing.</p> : null}
      {failed ? <p role="alert">Could not play this clip. Check its attachment or browser audio permissions.</p> : null}
    </div>
  )
}
