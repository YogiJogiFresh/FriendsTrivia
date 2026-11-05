export interface AudioPlaybackSettings {
  delaySeconds: number
  /** Total plays; zero loops until stopped. */
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
} = {}) {
  if (!validPlayback(settings)) throw new Error('Invalid song playback settings')
  let state: PlaybackState = 'idle'
  let plays = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let due = 0
  let remaining = 0
  let nextPlay = true
  let generation = 0
  let disposed = false
  audio.loop = false

  function update(value: PlaybackState) {
    state = value
    if (!disposed) callbacks.onState?.(state, plays)
  }
  function clear() {
    generation += 1
    clearTimeout(timer)
    timer = undefined
  }
  function failure(reason: PlaybackFailure) {
    if (disposed) return
    clear()
    audio.pause()
    update('paused')
    callbacks.onError?.(reason)
  }
  function play() {
    timer = undefined
    remaining = 0
    const ticket = ++generation
    update('starting')
    void audio.play().then(() => {
      if (disposed || ticket !== generation) return
      if (nextPlay) plays += 1
      nextPlay = false
      update('playing')
    }).catch((error: unknown) => {
      if (!disposed && ticket === generation) failure(playbackFailure(error, audio.error))
    })
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
    if (settings.playCount > 0 && plays >= settings.playCount) {
      update('finished')
      return
    }
    audio.currentTime = 0
    nextPlay = true
    wait(settings.delaySeconds * 1000)
  }
  function stop() {
    clear()
    audio.pause()
    audio.currentTime = 0
    plays = 0
    remaining = 0
    nextPlay = true
    update('idle')
  }
  function start() {
    if (disposed) return
    stop()
    wait(settings.delaySeconds * 1000)
  }
  function pause() {
    if (state !== 'waiting' && state !== 'starting' && state !== 'playing') return
    if (state === 'waiting') remaining = Math.max(0, due - Date.now())
    clear()
    audio.pause()
    update('paused')
  }
  function resume() {
    if (disposed) return
    if (state === 'idle') start()
    else if (state === 'paused') wait(remaining)
  }
  audio.addEventListener('ended', ended)
  function mediaFailed() {
    if (audio.error) failure(playbackFailure(undefined, audio.error))
  }
  audio.addEventListener('error', mediaFailed)
  return {
    start, pause, resume, stop,
    dispose() {
      disposed = true
      stop()
      audio.removeEventListener('ended', ended)
      audio.removeEventListener('error', mediaFailed)
    },
  }
}
