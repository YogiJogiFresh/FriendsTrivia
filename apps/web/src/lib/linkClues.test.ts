import { describe, expect, it } from 'vitest'
import { completeLinkPlaylist, replaceClueMedia, validLinkConfig } from './linkClues'

describe('Link clue editing', () => {
  it('requires four distinct slots and a bounded whole-second hint delay', () => {
    const mediaAssetIds = ['one', 'two', 'three', 'four']
    expect(completeLinkPlaylist(mediaAssetIds)).toEqual(mediaAssetIds)
    for (const invalid of [[], mediaAssetIds.slice(1), ['one', 'one', 'three', 'four'], ['one', null, 'three', 'four']]) {
      expect(completeLinkPlaylist(invalid)).toBeUndefined()
    }
    for (const hintDelaySeconds of [0, 10, 300]) expect(validLinkConfig({ mediaAssetIds, hintDelaySeconds })).toBe(true)
    for (const hintDelaySeconds of [-1, 0.5, 301, NaN, Infinity]) expect(validLinkConfig({ mediaAssetIds, hintDelaySeconds })).toBe(false)
  })

  it('replaces or clears matching draft slots without changing order or other settings', () => {
    const clue = { mediaAssetId: 'one', revealMediaAssetId: 'one', config: {
      correctAnswer: 'Answer', acceptedAnswers: ['other'],
      link: { mediaAssetIds: ['one', 'two', 'three', 'four'], hintDelaySeconds: 10 },
    } }
    const original = structuredClone(clue)
    const replaced = replaceClueMedia(clue, 'one', 'adjusted')
    expect(replaced).toMatchObject({ mediaAssetId: 'adjusted', revealMediaAssetId: 'adjusted',
      config: { correctAnswer: 'Answer', acceptedAnswers: ['other'],
        link: { mediaAssetIds: ['adjusted', 'two', 'three', 'four'], hintDelaySeconds: 10 } } })
    expect(replaceClueMedia(replaced, 'two', null).config.link?.mediaAssetIds).toEqual(['adjusted', null, 'three', 'four'])
    expect(clue).toEqual(original)
  })
})
