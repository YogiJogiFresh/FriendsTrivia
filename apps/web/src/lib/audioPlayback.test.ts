import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAudioPlayback, playbackFailure } from './audioPlayback'

afterEach(() => vi.useRealTimers())

function player(delaySeconds = 2, playCount = 2, playlist?: readonly string[]) {
  vi.useFakeTimers()
  const audio = Object.assign(new EventTarget(), {
    src: 'assigned-source', currentTime: 0, loop: true,
    play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(),
    error: null as { code: number } | null,
  })
  const onState = vi.fn()
  const onError = vi.fn()
  const onTrack = vi.fn()
  const playback = createAudioPlayback(audio as unknown as HTMLAudioElement, { delaySeconds, playCount }, { onState, onError, playlist, onTrack })
  return { audio, playback, onState, onError, onTrack }
}

describe('song delay and play count', () => {
  it('delays the first play and each repeat, then stops at the total count', async () => {
    const { audio, playback, onState } = player()
    playback.start()
    await vi.advanceTimersByTimeAsync(1999)
    expect(audio.play).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(audio.play).toHaveBeenCalledTimes(1)
    audio.dispatchEvent(new Event('ended'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(audio.play).toHaveBeenCalledTimes(2)
    audio.dispatchEvent(new Event('ended'))
    playback.resume()
    await vi.advanceTimersByTimeAsync(10000)
    expect(audio.play).toHaveBeenCalledTimes(2)
    expect(onState).toHaveBeenLastCalledWith('finished', 2)
    expect(audio.src).toBe('assigned-source')
    expect(audio.load).not.toHaveBeenCalled()
    playback.dispose()
  })

  describe('ordered audio playlists', () => {
    const sources = ['https://audio.test/1', 'https://audio.test/2', 'https://audio.test/3', 'https://audio.test/4']
    const settle = () => vi.advanceTimersByTimeAsync(0)

    it('plays every source to its end in order, then loops the complete list', async () => {
      const { audio, playback, onTrack, onState } = player(0, 0, sources)
      expect(audio.play).not.toHaveBeenCalled()
      playback.start()
      await settle()
      for (let index = 0; index < 9; index++) {
        expect(audio.src).toBe(sources[index % 4])
        expect(audio.play).toHaveBeenCalledTimes(index + 1)
        audio.currentTime = 27
        audio.dispatchEvent(new Event('timeupdate'))
        await vi.advanceTimersByTimeAsync(10000)
        expect(audio.src).toBe(sources[index % 4])
        audio.dispatchEvent(new Event('ended'))
        await settle()
      }
      expect(onTrack.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1])
      expect(onState).toHaveBeenLastCalledWith('playing', 3)
      playback.dispose()
    })

    it('counts finite plays as full passes and delays only between passes', async () => {
      const { audio, playback, onState } = player(1, 2, sources)
      playback.start()
      await vi.advanceTimersByTimeAsync(1000)
      for (let pass = 0; pass < 2; pass++) {
        for (let track = 0; track < 4; track++) {
          expect(audio.src).toBe(sources[track])
          audio.dispatchEvent(new Event('ended'))
          await settle()
        }
        if (pass === 0) {
          expect(onState).toHaveBeenLastCalledWith('waiting', 1)
          await vi.advanceTimersByTimeAsync(1000)
        }
      }
      expect(onState).toHaveBeenLastCalledWith('finished', 2)
      playback.resume()
      await vi.advanceTimersByTimeAsync(10000)
      expect(audio.play).toHaveBeenCalledTimes(8)
      playback.dispose()
    })

    it('ignores a queued end event when the newly selected source has not ended', async () => {
      const { audio, playback } = player(0, 0, sources)
      const media = Object.assign(audio, { ended: false })
      media.load.mockImplementation(() => { media.ended = false })
      playback.start()
      await settle()
      media.ended = true
      media.dispatchEvent(new Event('ended'))
      await settle()
      media.dispatchEvent(new Event('ended'))
      await settle()
      expect(media.src).toBe(sources[1])
      expect(media.play).toHaveBeenCalledTimes(2)
      playback.dispose()
    })

    it('preserves the current source and seek position on pause, but replays from source one', async () => {
      const { audio, playback, onTrack } = player(0, 0, sources)
      playback.start()
      await settle()
      audio.dispatchEvent(new Event('ended'))
      await settle()
      audio.currentTime = 12.5
      playback.pause()
      audio.dispatchEvent(new Event('ended'))
      playback.resume()
      await settle()
      expect(audio.src).toBe(sources[1])
      expect(audio.currentTime).toBe(12.5)
      expect(audio.load).toHaveBeenCalledTimes(2)
      expect(onTrack.mock.calls.map(([index]) => index)).toEqual([0, 1])
      playback.start()
      await settle()
      expect(audio.src).toBe(sources[0])
      expect(audio.currentTime).toBe(0)
      playback.dispose()
    })

    it('ignores stale rejected plays and captured media events after replay', async () => {
      const { audio, playback, onError, onState } = player(0, 0, sources)
      const addListener = vi.spyOn(audio, 'addEventListener')
      playback.start()
      await settle()
      const oldEnded = addListener.mock.calls.find(([type]) => type === 'ended')![1] as EventListener
      const oldError = addListener.mock.calls.find(([type]) => type === 'error')![1] as EventListener
      let reject!: (error: Error) => void
      audio.play.mockImplementationOnce(() => new Promise<void>((_resolve, failure) => { reject = failure }))
      audio.dispatchEvent(new Event('ended'))
      playback.start()
      await settle()
      reject(new Error('stale source'))
      audio.error = { code: 2 }
      oldEnded(new Event('ended'))
      oldError(new Event('error'))
      await settle()
      expect(audio.src).toBe(sources[0])
      expect(onState).toHaveBeenLastCalledWith('playing', 1)
      expect(onError).not.toHaveBeenCalled()
      playback.dispose()
    })

    it.each(['stop', 'dispose'] as const)('cancels a pending source start and listeners on %s', async (action) => {
      const { audio, playback, onError, onState } = player(0, 0, sources)
      playback.start()
      await settle()
      let resolve!: () => void
      audio.play.mockImplementationOnce(() => new Promise<void>(finish => { resolve = finish }))
      audio.dispatchEvent(new Event('ended'))
      playback[action]()
      const updates = onState.mock.calls.length
      resolve()
      audio.error = { code: 3 }
      audio.dispatchEvent(new Event('ended'))
      audio.dispatchEvent(new Event('error'))
      await vi.advanceTimersByTimeAsync(10000)
      expect(audio.play).toHaveBeenCalledTimes(2)
      expect(onState).toHaveBeenCalledTimes(updates)
      expect(onError).not.toHaveBeenCalled()
      playback.dispose()
    })

    it.each(['promise', 'load', 'media'] as const)('stops rather than skips on a %s failure; explicit retry restarts source one', async (kind) => {
      const { audio, playback, onError, onState } = player(0, 0, sources)
      playback.start()
      await settle()
      if (kind === 'promise') audio.play.mockRejectedValueOnce(new Error('failed track'))
      if (kind === 'load') audio.load.mockImplementationOnce(() => { throw new Error('failed load') })
      audio.dispatchEvent(new Event('ended'))
      if (kind === 'media') {
        audio.error = { code: 2 }
        audio.dispatchEvent(new Event('error'))
      }
      await settle()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onState).toHaveBeenLastCalledWith('paused', 1)
      playback.resume()
      audio.dispatchEvent(new Event('ended'))
      await vi.advanceTimersByTimeAsync(10000)
      expect(audio.src).toBe(sources[1])
      audio.error = null
      playback.start()
      await settle()
      expect(audio.src).toBe(sources[0])
      expect(onState).toHaveBeenLastCalledWith('playing', 1)
      playback.dispose()
    })
  })

  it('preserves the remaining initial/inter-repeat delay and count through pause/resume', async () => {
    const { audio, playback, onState } = player()
    playback.start()
    await vi.advanceTimersByTimeAsync(750)
    playback.pause()
    await vi.advanceTimersByTimeAsync(10000)
    playback.resume()
    await vi.advanceTimersByTimeAsync(1249)
    expect(audio.play).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    playback.pause()
    playback.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(onState).toHaveBeenLastCalledWith('playing', 1)
    audio.dispatchEvent(new Event('ended'))
    await vi.advanceTimersByTimeAsync(500)
    playback.pause()
    playback.resume()
    await vi.advanceTimersByTimeAsync(1499)
    expect(onState).toHaveBeenLastCalledWith('waiting', 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(onState).toHaveBeenLastCalledWith('playing', 2)
    playback.dispose()
  })

  it('loops at zero and cancels pending repeats on stop or disposal', async () => {
    const { audio, playback } = player(1, 0)
    playback.start()
    for (let count = 0; count < 4; count++) {
      await vi.advanceTimersByTimeAsync(1000)
      audio.dispatchEvent(new Event('ended'))
    }
    expect(audio.play).toHaveBeenCalledTimes(4)
    playback.stop()
    await vi.advanceTimersByTimeAsync(10000)
    expect(audio.play).toHaveBeenCalledTimes(4)
    playback.start()
    playback.dispose()
    audio.dispatchEvent(new Event('ended'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(audio.play).toHaveBeenCalledTimes(4)
  })

  it('restarts the complete sequence explicitly, but does not restart on repeated resume calls', async () => {
    const { audio, playback, onState } = player(0, 1)
    playback.resume()
    await vi.advanceTimersByTimeAsync(0)
    playback.resume()
    expect(audio.play).toHaveBeenCalledTimes(1)
    audio.dispatchEvent(new Event('ended'))
    playback.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onState).toHaveBeenLastCalledWith('playing', 1)
    expect(audio.play).toHaveBeenCalledTimes(2)
    playback.dispose()
  })

  it('ignores stale rejected plays after cancellation and surfaces current failures', async () => {
    const { audio, playback, onError } = player(0, 1)
    let reject!: (error: Error) => void
    audio.play.mockImplementationOnce(() => new Promise<void>((_resolve, failure) => { reject = failure }))
    playback.start()
    playback.stop()
    reject(new Error('stale'))
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).not.toHaveBeenCalled()
    audio.play.mockRejectedValueOnce(new Error('blocked'))
    playback.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    playback.dispose()
  })
  it('distinguishes scheduled delay from a pending play and ignores stale successful starts', async () => {
    const { audio, playback, onState } = player(1, 1)
    let finish!: () => void
    audio.play.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    playback.start()
    expect(onState).toHaveBeenLastCalledWith('waiting', 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onState).toHaveBeenLastCalledWith('starting', 0)
    playback.pause()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(onState).toHaveBeenLastCalledWith('paused', 0)
    playback.dispose()
  })
  it('classifies browser evidence without assuming every failure is autoplay', () => {
    expect(playbackFailure({ name: 'NotAllowedError' })).toBe('autoplay')
    expect(playbackFailure(undefined, { code: 2 })).toBe('network')
    expect(playbackFailure(undefined, { code: 3 })).toBe('decode')
    expect(playbackFailure(undefined, { code: 4 })).toBe('unavailable')
    expect(playbackFailure(new Error('private-detail'))).toBe('unknown')
  })
})
