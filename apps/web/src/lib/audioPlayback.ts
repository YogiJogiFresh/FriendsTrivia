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

export type PlaybackState = 'idle' | 'waiting' | 'playing' | 'paused' | 'finished'

export function createAudioPlayback(audio: HTMLAudioElement, settings: AudioPlaybackSettings, callbacks: {
  onState?: (state: PlaybackState, plays: number) => void
  onError?: () => void
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
  function failure() {
    if (disposed) return
    clear()
    audio.pause()
    update('paused')
    callbacks.onError?.()
  }
  function play() {
    timer = undefined
    remaining = 0
    const ticket = ++generation
    void audio.play().then(() => {
      if (disposed || ticket !== generation) return
      if (nextPlay) plays += 1
      nextPlay = false
      update('playing')
    }).catch(() => {
      if (!disposed && ticket === generation) failure()
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
    if (state !== 'waiting' && state !== 'playing') return
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
  audio.addEventListener('error', failure)
  return {
    start, pause, resume, stop,
    dispose() {
      disposed = true
      stop()
      audio.removeEventListener('ended', ended)
      audio.removeEventListener('error', failure)
    },
  }
}
