export const MAX_SOURCE_BYTES = 50 * 1024 * 1024
export const MAX_SOURCE_SECONDS = 10 * 60
export const MP3_BITRATE = 128

const audioTypes: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
}

export interface TrimRange { start: number; end: number }
export interface DecodedSong { channels: Float32Array[]; sampleRate: number; duration: number; peaks: number[] }

export function sourceType(file: Pick<File, 'name' | 'size'>): string {
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error('Choose a nonempty song up to 50 MB.')
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!audioTypes[extension]) throw new Error('Choose an MP3, M4A, OGG, or WAV file.')
  return audioTypes[extension]
}

export function parseTimestamp(value: string): number {
  if (!/^(?:\d+:)?\d{1,2}(?:\.\d{1,3})?$/.test(value.trim())) return NaN
  const parts = value.trim().split(':').map(Number)
  const seconds = parts.at(-1)!
  if (parts.length === 2 && seconds >= 60) return NaN
  return (parts.length === 2 ? parts[0] * 60 : 0) + seconds
}

export function formatTimestamp(seconds: number): string {
  const centiseconds = Math.round(seconds * 100)
  return `${Math.floor(centiseconds / 6000)}:${((centiseconds % 6000) / 100).toFixed(2).padStart(5, '0')}`
}

export function validRange(range: TrimRange, duration: number): boolean {
  return Number.isFinite(range.start) && Number.isFinite(range.end) &&
    range.start >= 0 && range.end > range.start && range.end <= duration
}

export function outputName(name: string, extension: string): string {
  const trimmed = name.trim()
  if (!trimmed || /[<>:"/\\|?*]/u.test(trimmed) || [...trimmed].some((char) => char.charCodeAt(0) < 32) || /^\.+$/.test(trimmed)) {
    throw new Error('Use a filename without path separators or special characters.')
  }
  const base = trimmed.toLowerCase().endsWith(extension.toLowerCase()) ? trimmed.slice(0, -extension.length).trim() : trimmed
  if (!base || base.length > 120 || base.endsWith('.')) throw new Error('Use a filename of 1–120 characters without a trailing dot.')
  return `${base}${extension}`
}

export function estimatedMp3Bytes(range: TrimRange): number {
  return Math.ceil((range.end - range.start) * MP3_BITRATE * 1000 / 8) + 2048
}

export function waveformPeaks(channels: Float32Array[], buckets = 600): number[] {
  const length = channels[0]?.length ?? 0
  if (!length) return []
  const count = Math.min(buckets, length)
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * length / count)
    const end = Math.floor((index + 1) * length / count)
    let peak = 0
    for (const channel of channels) {
      for (let sample = start; sample < end; sample++) peak = Math.max(peak, Math.abs(channel[sample]))
    }
    return peak
  })
}

export function slicePcm(song: DecodedSong, range: TrimRange): Float32Array[] {
  if (!validRange(range, song.duration)) throw new Error('Set a start before the end, within the song.')
  const start = Math.round(range.start * song.sampleRate)
  const end = Math.min(song.channels[0].length, Math.round(range.end * song.sampleRate))
  if (end <= start) throw new Error('The selected clip is too short.')
  return song.channels.map((channel) => channel.slice(start, end))
}

export async function decodeSong(file: File, signal: AbortSignal): Promise<DecodedSong> {
  sourceType(file)
  const url = URL.createObjectURL(file)
  const audio = new Audio()
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        audio.onloadedmetadata = null
        audio.onerror = null
        signal.removeEventListener('abort', abort)
      }
      const fail = (error: Error) => { cleanup(); reject(error) }
      const abort = () => fail(new DOMException('Canceled', 'AbortError'))
      const timer = setTimeout(() => fail(new Error('Could not read the song. Try a different audio file.')), 20000)
      audio.onloadedmetadata = () => { cleanup(); resolve() }
      audio.onerror = () => fail(new Error('This browser cannot read that audio format. Try MP3 or WAV.'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      audio.preload = 'metadata'
      audio.src = url
    })
    if (!Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration > MAX_SOURCE_SECONDS) {
      throw new Error('Choose a song no longer than 10 minutes.')
    }
  } finally {
    audio.removeAttribute('src')
    audio.load()
    URL.revokeObjectURL(url)
  }
  signal.throwIfAborted()
  const context = new AudioContext({ sampleRate: 44100 })
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer())
    signal.throwIfAborted()
    if (buffer.duration > MAX_SOURCE_SECONDS || buffer.numberOfChannels > 2 ||
        buffer.length * buffer.numberOfChannels * 4 > 256 * 1024 * 1024) {
      throw new Error('Choose a mono or stereo song up to 10 minutes with less decoded audio data.')
    }
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
    return { channels, sampleRate: buffer.sampleRate, duration: buffer.duration, peaks: waveformPeaks(channels) }
  } catch (error) {
    if (signal.aborted || error instanceof Error && error.message.startsWith('Choose a mono')) throw error
    throw new Error('Could not decode this song. Try another MP3 or WAV file.')
  } finally {
    await context.close()
  }
}

export function encodeSnippet(song: DecodedSong, range: TrimRange, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted()
  const channels = slicePcm(song, range)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mp3Encoder.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new DOMException('Canceled', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = () => { cleanup(); reject(new Error('MP3 encoding failed. Try a shorter clip.')) }
    worker.onmessage = (event: MessageEvent<{ bytes?: ArrayBuffer; error?: string }>) => {
      cleanup()
      if (event.data.bytes) resolve(new Blob([event.data.bytes], { type: 'audio/mpeg' }))
      else reject(new Error(event.data.error ?? 'MP3 encoding failed.'))
    }
    worker.postMessage({ channels, sampleRate: song.sampleRate }, channels.map((channel) => channel.buffer))
  })
}
