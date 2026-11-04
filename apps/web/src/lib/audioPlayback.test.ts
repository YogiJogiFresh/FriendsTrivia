import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAudioPlayback } from './audioPlayback'

afterEach(() => vi.useRealTimers())

function player(delaySeconds = 2, playCount = 2) {
  vi.useFakeTimers()
  const audio = Object.assign(new EventTarget(), {
    currentTime: 0, loop: true, play: vi.fn(async () => {}), pause: vi.fn(),
  })
  const onState = vi.fn()
  const onError = vi.fn()
  const playback = createAudioPlayback(audio as unknown as HTMLAudioElement, { delaySeconds, playCount }, { onState, onError })
  return { audio, playback, onState, onError }
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
    playback.dispose()
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
})
