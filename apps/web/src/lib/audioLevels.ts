export interface AudioLevelSettings {
  normalize: boolean
  gainDb: number
}

export interface AudioLevelInfo {
  inputDb: number | null
  requestedDb: number
  appliedDb: number
  peakLimited: boolean
  boostLimited: boolean
}

export function validAudioLevels(settings: AudioLevelSettings): boolean {
  return typeof settings.normalize === 'boolean' && Number.isFinite(settings.gainDb) &&
    settings.gainDb >= -12 && settings.gainDb <= 12 && Number.isInteger(settings.gainDb * 2)
}

export function measureAudioLevels(channels: Float32Array[], sampleRate: number, settings: AudioLevelSettings): AudioLevelInfo {
  if (!validAudioLevels(settings) || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
    !channels.length || channels.length > 2 || !channels[0].length ||
    channels.some((channel) => channel.length !== channels[0].length)) throw new Error('Invalid audio level settings or samples.')

  const windows: Array<{ energy: number; samples: number }> = []
  const windowSize = Math.max(1, Math.round(sampleRate * 0.1))
  let peak = 0
  for (let start = 0; start < channels[0].length; start += windowSize) {
    const end = Math.min(start + windowSize, channels[0].length)
    let energy = 0
    for (const channel of channels) {
      for (let index = start; index < end; index++) {
        const value = channel[index]
        if (!Number.isFinite(value)) throw new Error('Audio contains invalid samples.')
        peak = Math.max(peak, Math.abs(value))
        energy += value * value
      }
    }
    const samples = (end - start) * channels.length
    if (energy / samples >= 1e-6) windows.push({ energy, samples })
  }
  const total = windows.reduce((sum, window) => ({ energy: sum.energy + window.energy, samples: sum.samples + window.samples }), { energy: 0, samples: 0 })
  const threshold = total.samples ? Math.max(1e-6, total.energy / total.samples * 0.01) : Infinity
  const audible = windows.filter((window) => window.energy / window.samples >= threshold)
  const measured = audible.reduce((sum, window) => ({ energy: sum.energy + window.energy, samples: sum.samples + window.samples }), { energy: 0, samples: 0 })
  // Approximate gated RMS, not frequency-weighted LUFS or true-peak mastering.
  const inputDb = measured.samples ? 10 * Math.log10(measured.energy / measured.samples) : null
  const requestedDb = (settings.normalize && inputDb !== null ? -18 - inputDb : 0) + settings.gainDb
  const adjusting = settings.normalize || settings.gainDb !== 0
  const peakLimit = peak > 0 ? -1 - 20 * Math.log10(peak) : Infinity
  return {
    inputDb,
    requestedDb,
    appliedDb: adjusting ? Math.min(requestedDb, 12, peakLimit) : 0,
    peakLimited: adjusting && peakLimit < Math.min(requestedDb, 12),
    boostLimited: adjusting && requestedDb > 12,
  }
}
