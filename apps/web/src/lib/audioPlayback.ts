export interface AudioPlaybackSettings {
  delaySeconds: number
  /** Total plays (full passes for playlists); zero loops until stopped. */
  playCount: number
}

export function playbackSettings(settings: AudioPlaybackSettings | undefined, reveal = false): AudioPlaybackSettings {
  return settings ?? { delaySeconds: 0, playCount: reveal ? 1 : 0 }
}

export function validPlayback(settings: AudioPlaybackSettings): boolean {
  return Number.isInteger(settings.delaySeconds) && settings.delaySeconds >= 0 && settings.delaySeconds <= 300 &&
    Number.isInteger(settings.playCount) && settings.playCount >= 0 && settings.playCount <= 100
}

export type PlaybackState = 'idle' | 'waiting' | 'starting' | 'playing' | 'paused' | 'finished'
export type PlaybackFailure = 'autoplay' | 'network' | 'decode' | 'unavailable' | 'unknown'

export function playbackFailure(error?: unknown, mediaError?: { code: number } | null): PlaybackFailure {
  if (typeof error === 'object' && error && 'name' in error && error.name === 'NotAllowedError') return 'autoplay'
  if (mediaError?.code === 2) return 'network'
  if (mediaError?.code === 3) return 'decode'
  if (mediaError?.code === 4) return 'unavailable'
  return 'unknown'
}

export const playbackFailureMessages: Record<PlaybackFailure, string> = {
  autoplay: 'The browser blocked this song. Select Play audio to allow playback.',
  network: 'The song download failed. Check your connection, then select Play audio to retry.',
  decode: 'The browser could not decode this song. Check the audio file or try a supported format.',
  unavailable: 'The song is unavailable or unsupported. Check its attachment and access, then retry.',
  unknown: 'Could not play this song. Check its attachment, connection, and browser audio permissions.',
}

export function createAudioPlayback(audio: HTMLAudioElement, settings: AudioPlaybackSettings, callbacks: {
  onState?: (state: PlaybackState, plays: number) => void
  onError?: (failure: PlaybackFailure) => void
  playlist?: readonly string[]
  onTrack?: (index: number) => void
} = {}) {
  if (!validPlayback(settings)) throw new Error('Invalid song playback settings')
  const playlist = callbacks.playlist ? [...callbacks.playlist] : undefined
  if (playlist && !playlist.length) throw new Error('Empty audio playlist')
  let state: PlaybackState = 'idle'
  let plays = 0
  let track = 0
  let sourcePending = !!playlist
  let failed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let due = 0
  let remaining = 0
  let nextPlay = true
  let generation = 0
  let disposed = false
  let removeListeners = () => {}
  audio.loop = false

  function update(value: PlaybackState) {
    state = value
    if (!disposed) callbacks.onState?.(state, plays)
  }
  function clear() {
    generation += 1
    clearTimeout(timer)
    timer = undefined
    removeListeners()
    removeListeners = () => {}
  }
  function failure(reason: PlaybackFailure) {
    if (disposed) return
    clear()
    failed = true
    audio.pause()
    update('paused')
    callbacks.onError?.(reason)
  }
  function play() {
    timer = undefined
    remaining = 0
    const ticket = ++generation
    update('starting')
    const current = () => !disposed && ticket === generation
    const endedCurrent = () => {
      // A queued end from the previous source must not end the newly loaded track.
      if (current() && audio.ended !== false) ended()
    }
    const mediaFailed = () => {
      if (current() && audio.error) failure(playbackFailure(undefined, audio.error))
    }
    audio.addEventListener('ended', endedCurrent)
    audio.addEventListener('error', mediaFailed)
    removeListeners = () => {
      audio.removeEventListener('ended', endedCurrent)
      audio.removeEventListener('error', mediaFailed)
    }
    try {
      if (playlist && sourcePending) {
        audio.src = playlist[track]
        audio.load()
        sourcePending = false
        if (!current()) return
        callbacks.onTrack?.(track)
      }
      if (!current()) return
      void audio.play().then(() => {
        if (!current()) return
        if (nextPlay && track === 0) plays += 1
        nextPlay = false
        update('playing')
      }).catch((error: unknown) => {
        if (current()) failure(playbackFailure(error, audio.error))
      })
    } catch (error) {
      if (current()) failure(playbackFailure(error, audio.error))
    }
  }
  function wait(milliseconds: number) {
    remaining = milliseconds
    due = Date.now() + milliseconds
    update('waiting')
    if (milliseconds > 0) timer = setTimeout(play, milliseconds)
    else play()
  }
  function ended() {
    if (disposed || state !== 'playing') return
    clear()
    const passEnded = !playlist || track === playlist.length - 1
    if (passEnded && settings.playCount > 0 && plays >= settings.playCount) {
      update('finished')
      return
    }
    if (playlist) {
      track = passEnded ? 0 : track + 1
      sourcePending = true
    }
    audio.currentTime = 0
    nextPlay = true
    wait(passEnded ? settings.delaySeconds * 1000 : 0)
  }
  function stop() {
    clear()
    audio.pause()
    audio.currentTime = 0
    plays = 0
    remaining = 0
    nextPlay = true
    track = 0
    sourcePending = !!playlist
    failed = false
    update('idle')
  }
  function start() {
    if (disposed) return
    stop()
    wait(settings.delaySeconds * 1000)
  }
  function pause() {
    if (disposed) return
    if (state !== 'waiting' && state !== 'starting' && state !== 'playing') return
    if (state === 'waiting') remaining = Math.max(0, due - Date.now())
    clear()
    audio.pause()
    update('paused')
  }
  function resume() {
    if (disposed) return
    if (state === 'idle') start()
    else if (state === 'paused' && (!playlist || !failed)) wait(remaining)
  }
  return {
    start, pause, resume, stop,
    dispose() {
      disposed = true
      stop()
    },
  }
}
