import encoderUrl from '@breezystack/lamejs?url'
import { measureAudioLevels } from './audioLevels'
import type { AudioLevelSettings } from './audioLevels'

self.onmessage = async (event: MessageEvent<{ channels: Float32Array[]; sampleRate: number; settings: AudioLevelSettings }>) => {
  try {
    const { Mp3Encoder } = await import(/* @vite-ignore */ encoderUrl) as typeof import('@breezystack/lamejs')
    const { channels, sampleRate, settings } = event.data
    if (channels.length < 1 || channels.length > 2 || !channels[0].length ||
        channels.some((channel) => channel.length !== channels[0].length) || sampleRate !== 44100) {
      throw new Error('Unsupported audio data.')
    }
    const levels = measureAudioLevels(channels, sampleRate, settings)
    const gain = 10 ** (levels.appliedDb / 20)
    const encoder = new Mp3Encoder(channels.length, sampleRate, 128)
    const chunks: Uint8Array[] = []
    let length = 0
    const append = (bytes: Uint8Array) => {
      const copy = new Uint8Array(bytes)
      chunks.push(copy)
      length += copy.length
    }
    for (let offset = 0; offset < channels[0].length; offset += 1152) {
      const pcm = channels.map((channel) => {
        const samples = channel.subarray(offset, offset + 1152)
        return Int16Array.from(samples, (sample) => {
          const value = Math.max(-1, Math.min(1, sample * gain))
          return Math.round(value * (value < 0 ? 32768 : 32767))
        })
      })
      append(encoder.encodeBuffer(pcm[0], pcm[1]))
    }
    append(encoder.flush())
    const output = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
    self.postMessage({ bytes: output.buffer, levels }, { transfer: [output.buffer] })
  } catch {
    self.postMessage({ error: 'Could not encode the clip as MP3. Try another song or a shorter range.' })
  }
}
