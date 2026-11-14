import { describe, expect, it } from 'vitest'
import { clueMediaIds, getLinkConfig } from './link.js'
import { validatePack } from './repositories/packs.js'

const link = { mediaAssetIds: ['one', 'two', 'three', 'four'], hintDelaySeconds: 10 }
const clue = { type: 'music_free_text', boardValue: 100, prompt: 'Connection?', config: { correctAnswer: 'Answer', link } }
const pack = { title: 'Link', categories: [{ title: 'Connections', clues: [clue] }] }

describe('Link configuration', () => {
  it('accepts optional multiline reveal text and rejects invalid or oversized values', () => {
    for (const revealNotes of ['', 'First song - First artist\nSecond song - Second artist', 'a'.repeat(2000)]) {
      const withNotes = { ...link, revealNotes }
      expect(() => validatePack({ ...pack, categories: [{ title: 'Links', clues: [
        { ...clue, config: { ...clue.config, link: withNotes } },
      ] }] })).not.toThrow()
      expect(getLinkConfig({ ...clue, config: { link: withNotes } })?.revealNotes)
        .toBe(revealNotes.trim() || undefined)
    }
    for (const revealNotes of [null, 7, {}, 'a'.repeat(2001)]) {
      expect(() => validatePack({ ...pack, categories: [{ title: 'Links', clues: [
        { ...clue, config: { ...clue.config, link: { ...link, revealNotes } } },
      ] }] })).toThrow('songs and artists')
      expect(getLinkConfig({ ...clue, config: { link: { ...link, revealNotes } } })?.revealNotes).toBeUndefined()
    }
  })
  it('distinguishes Link from free text and keeps deleted or malformed Links marked', () => {
    expect(getLinkConfig({ ...clue, config: { correctAnswer: 'Answer' } })).toBeUndefined()
    expect(getLinkConfig(clue)).toEqual(link)
    expect(getLinkConfig({ ...clue, config: { link: { ...link, mediaAssetIds: ['one', null, 'three', 'four'] } } }))
      .toEqual({ ...link, mediaAssetIds: ['one', null, 'three', 'four'] })
    for (const invalid of [null, {}, { ...link, mediaAssetIds: ['one'] },
      { ...link, mediaAssetIds: ['one', 'one', 'three', 'four'] }, { ...link, hintDelaySeconds: NaN }]) {
      expect(getLinkConfig({ ...clue, config: { link: invalid } })?.mediaAssetIds).toEqual([null, null, null, null])
    }
  })

  it('accepts valid settings and rejects malformed playlists, delays and other clue types', () => {
    for (const hintDelaySeconds of [0, 10, 300]) {
      expect(() => validatePack({ ...pack, categories: [{ title: 'Links', clues: [
        { ...clue, config: { ...clue.config, link: { ...link, hintDelaySeconds } } },
      ] }] })).not.toThrow()
    }
    for (const invalid of [null, [], {}, { ...link, mediaAssetIds: ['one', 'two', 'three'] },
      { ...link, mediaAssetIds: ['one', 'two', 'three', 'four', 'five'] },
      { ...link, mediaAssetIds: ['one', 'two', 'three', 'one'] },
      { ...link, mediaAssetIds: ['one', 'two', 'three', ' '] },
      { ...link, mediaAssetIds: ['one', 'two', 'three', null] },
      ...[-1, 301, 1.5, Infinity, NaN, '10', undefined].map((hintDelaySeconds) => ({ ...link, hintDelaySeconds }))]) {
      expect(() => validatePack({ ...pack, categories: [{ title: 'Links', clues: [
        { ...clue, config: { ...clue.config, link: invalid } },
      ] }] })).toThrow()
    }
    for (const type of ['music_multiple_choice', 'price_slider']) {
      expect(() => validatePack({ ...pack, categories: [{ title: 'Links', clues: [{ ...clue, type }] }] })).toThrow('free-text')
    }
    expect(() => validatePack({ ...pack, categories: [{ title: 'Links', clues: [
      { ...clue, config: { link, correctAnswer: '' } },
    ] }] })).toThrow('correct answer')
  })

  it('collects and deduplicates all ordinary, reveal and playlist media references', () => {
    expect(clueMediaIds({ ...clue, mediaAssetId: 'one', revealMediaAssetId: 'answer' }))
      .toEqual(['one', 'answer', 'two', 'three', 'four'])
    expect(clueMediaIds({ ...clue, config: { link: { ...link, hintDelaySeconds: 'corrupt' } } }))
      .toEqual(link.mediaAssetIds)
  })
})
