import { describe, expect, it } from 'vitest'
import { measureAudioLevels, validAudioLevels } from './audioLevels'

const settings = { normalize: true, gainDb: 0 }
const tone = (amplitude: number) => Float32Array.from({ length: 44100 }, (_, index) => amplitude * Math.sin(index * 2 * Math.PI * 440 / 44100))

describe('approximate audio level matching', () => {
  it('matches quiet and loud signals to the same average target without changing source samples', () => {
    for (const amplitude of [0.05, 0.5]) {
      const source = tone(amplitude)
      const original = source.slice()
      const level = measureAudioLevels([source], 44100, settings)
      expect(level.inputDb! + level.appliedDb).toBeCloseTo(-18, 3)
      expect(level.peakLimited).toBe(false)
      expect(source).toEqual(original)
    }
  })

  it('excludes silent padding, handles very short clips, and never automatically boosts near-silence', () => {
    const source = tone(0.1)
    const padded = new Float32Array(source.length * 3)
    padded.set(source, source.length)
    expect(measureAudioLevels([padded], 44100, settings).inputDb)
      .toBeCloseTo(measureAudioLevels([source], 44100, settings).inputDb!, 5)
    expect(measureAudioLevels([new Float32Array([0.1])], 44100, settings).inputDb).toBeCloseTo(-20)
    for (const source of [new Float32Array(400), tone(0.00001)]) {
      const level = measureAudioLevels([source], 44100, settings)
      expect(level.inputDb).toBeNull()
      expect(level.appliedDb).toBe(0)
    }
  })

  it('uses the loudest stereo peak and applies one gain rather than changing the balance or clipping transients', () => {
    const left = tone(0.02)
    const right = tone(0.01)
    right[1000] = 0.95
    const level = measureAudioLevels([left, right], 44100, settings)
    expect(level.peakLimited).toBe(true)
    expect(0.95 * 10 ** (level.appliedDb / 20)).toBeCloseTo(10 ** (-1 / 20), 6)
    expect(level.inputDb! + level.appliedDb).toBeLessThan(-18)
  })

  it('supports manual-only gain, combined adjustment and attenuation, with a bounded total boost', () => {
    const source = tone(0.1)
    expect(measureAudioLevels([source], 44100, { normalize: false, gainDb: -6 }).appliedDb).toBe(-6)
    const combined = measureAudioLevels([source], 44100, { normalize: true, gainDb: 1.5 })
    expect(combined.inputDb! + combined.appliedDb).toBeCloseTo(-16.5)
    const quiet = measureAudioLevels([tone(0.002)], 44100, settings)
    expect(quiet.appliedDb).toBe(12)
    expect(quiet.boostLimited).toBe(true)
    expect(measureAudioLevels([tone(1)], 44100, { normalize: false, gainDb: 0 }).appliedDb).toBe(0)
  })

  it('rejects invalid controls, channel shapes, sample rates and non-finite samples', () => {
    for (const gainDb of [NaN, Infinity, -12.5, 12.5, 0.1]) {
      expect(validAudioLevels({ normalize: false, gainDb })).toBe(false)
      expect(() => measureAudioLevels([tone(0.1)], 44100, { normalize: false, gainDb })).toThrow()
    }
    for (const channels of [[], [new Float32Array()], [tone(0.1), new Float32Array(2)], [new Float32Array([NaN])]]) {
      expect(() => measureAudioLevels(channels, 44100, settings)).toThrow()
    }
    expect(() => measureAudioLevels([tone(0.1)], 0, settings)).toThrow()
  })
})
