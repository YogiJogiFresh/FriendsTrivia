import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeSong, encodeSnippet, estimatedMp3Bytes, formatTimestamp, MAX_SOURCE_BYTES, outputName,
  parseTimestamp, slicePcm, sourceType, validRange, waveformPeaks,
} from './audioSnippets'
import type { DecodedSong } from './audioSnippets'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const song: DecodedSong = {
  channels: [Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5]), Float32Array.from([0, -0.1, -0.2, -0.3, -0.4, -0.5])],
  sampleRate: 2, duration: 3, peaks: [],
}

describe('audio snippet preparation', () => {
  it('accepts supported source names but rejects empty, oversized and unsupported files', () => {
    expect(sourceType({ name: 'SONG.MP3', size: 12 })).toBe('audio/mpeg')
    expect(sourceType({ name: 'song.m4a', size: 12 })).toBe('audio/mp4')
    expect(() => sourceType({ name: 'song.mp3', size: 0 })).toThrow('nonempty')
    expect(() => sourceType({ name: 'song.mp3', size: MAX_SOURCE_BYTES + 1 })).toThrow('50 MB')
    expect(() => sourceType({ name: 'song.webm', size: 12 })).toThrow('MP3, M4A, OGG, or WAV')
  })

  it('parses precise timestamps and rejects missing, malformed, or invalid seconds', () => {
    expect(parseTimestamp('1:02.250')).toBe(62.25)
    expect(parseTimestamp(' 05.50 ')).toBe(5.5)
    for (const value of ['', '-1', '1:60', '0:1:20', 'Infinity', '1.2345', '20x']) {
      expect(parseTimestamp(value)).toBeNaN()
    }
    expect(formatTimestamp(59.999)).toBe('1:00.00')
    expect(formatTimestamp(62.25)).toBe('1:02.25')
  })

  it('validates ranges and copies only the selected samples in every channel', () => {
    expect(validRange({ start: 0, end: 3 }, 3)).toBe(true)
    for (const range of [{ start: NaN, end: 2 }, { start: -1, end: 2 }, { start: 2, end: 2 }, { start: 0, end: 4 }]) {
      expect(validRange(range, 3)).toBe(false)
      expect(() => slicePcm(song, range)).toThrow()
    }
    const clipped = slicePcm(song, { start: 1, end: 2 })
    expect([...clipped[0]]).toEqual([...song.channels[0].slice(2, 4)])
    expect([...clipped[1]]).toEqual([...song.channels[1].slice(2, 4)])
    clipped[0][0] = 1
    expect(song.channels[0][2]).not.toBe(1)
    expect(() => slicePcm(song, { start: 0.01, end: 0.02 })).toThrow('too short')
  })

  it('uses the loudest sample from either channel for bounded waveform peaks', () => {
    expect(waveformPeaks([new Float32Array([0, 0.8, 0, 0]), new Float32Array([0, 0, 0, -1])], 2))
      .toEqual([expect.closeTo(0.8), 1])
    expect(waveformPeaks([new Float32Array([0, 0])], 600)).toEqual([0, 0])
    expect(waveformPeaks([])).toEqual([])
  })

  it('keeps safe names with the correct extension and does not permit path-like or blank names', () => {
    expect(outputName('  My question  ', '.mp3')).toBe('My question.mp3')
    expect(outputName('My question.MP3', '.mp3')).toBe('My question.mp3')
    expect(outputName('Original', '.ogg')).toBe('Original.ogg')
    for (const name of ['', ' ', '../song', 'C:\\song', 'bad\nname', '..', 'song.', 'a'.repeat(121)]) {
      expect(() => outputName(name, '.mp3')).toThrow()
    }
    expect(estimatedMp3Bytes({ start: 12, end: 42 })).toBe(482048)
  })
})

class FakeWorker {
  static latest: FakeWorker
  onerror?: () => void
  onmessage?: (event: { data: { bytes?: ArrayBuffer; error?: string } }) => void
  message?: { channels: Float32Array[]; sampleRate: number }
  terminate = vi.fn()
  constructor() { FakeWorker.latest = this }
  postMessage(message: FakeWorker['message']) { this.message = message }
}

describe('MP3 worker lifecycle', () => {
  it('sends trimmed PCM to the worker and returns its encoded bytes as MP3', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const result = encodeSnippet(song, { start: 1, end: 2 }, new AbortController().signal)
    const worker = FakeWorker.latest
    expect(worker.message?.channels[0].length).toBe(2)
    expect(worker.message?.channels[1].length).toBe(2)
    worker.onmessage!({ data: { bytes: new Uint8Array([255, 251, 144]).buffer } })
    const blob = await result
    expect(blob.type).toBe('audio/mpeg')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([255, 251, 144])
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  describe('local source decoding safeguards', () => {
    const file = { name: 'Source.wav', size: 12, arrayBuffer: vi.fn(async () => new ArrayBuffer(12)) } as unknown as File

    function metadata(duration: number, ready = true) {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
      vi.stubGlobal('Audio', class {
        duration = duration
        onloadedmetadata: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_value: string) { if (ready) queueMicrotask(() => this.onloadedmetadata?.()) }
        removeAttribute() {}
        load() {}
      })
      return revoke
    }

    it('rejects songs over ten minutes from metadata before allocating decoded PCM', async () => {
      const revoke = metadata(601)
      const context = vi.fn()
      vi.stubGlobal('AudioContext', context)
      await expect(decodeSong(file, new AbortController().signal)).rejects.toThrow('10 minutes')
      expect(context).not.toHaveBeenCalled()
      expect(revoke).toHaveBeenCalledWith('blob:fixture')
    })

    it('cancels metadata work and releases its local source URL', async () => {
      const revoke = metadata(10, false)
      const controller = new AbortController()
      const result = decodeSong(file, controller.signal)
      controller.abort()
      await expect(result).rejects.toMatchObject({ name: 'AbortError' })
      expect(revoke).toHaveBeenCalledOnce()
    })

    it('rejects unsupported decoded channel counts and closes the audio context', async () => {
      metadata(10)
      const close = vi.fn(async () => undefined)
      vi.stubGlobal('AudioContext', class {
        async decodeAudioData() { return { duration: 10, numberOfChannels: 6, length: 441000 } }
        close = close
      })
      await expect(decodeSong(file, new AbortController().signal)).rejects.toThrow('mono or stereo')
      expect(close).toHaveBeenCalledOnce()
    })
  })

  it('terminates canceled work and rejects its pending result', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const result = encodeSnippet(song, { start: 0, end: 1 }, controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce()
    expect(() => encodeSnippet(song, { start: 0, end: 1 }, controller.signal)).toThrow()
  })

  it('surfaces encoder and worker failures and always terminates the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const result = encodeSnippet(song, { start: 0, end: 1 }, new AbortController().signal)
    FakeWorker.latest.onmessage!({ data: { error: 'Encoding failed' } })
    await expect(result).rejects.toThrow('Encoding failed')
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce()
    const crash = encodeSnippet(song, { start: 0, end: 1 }, new AbortController().signal)
    FakeWorker.latest.onerror!()
    await expect(crash).rejects.toThrow('MP3 encoding failed')
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce()
  })
})
