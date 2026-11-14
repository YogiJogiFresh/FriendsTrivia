import { describe, expect, it } from 'vitest'
import { boardFromDraft, clueFromDraft } from './packPreview'
import type { PreviewDraftCategory, PreviewDraftClue } from './packPreview'

const clue: PreviewDraftClue = {
  key: 'unsaved-clue',
  type: 'music_free_text',
  boardValue: 200,
  prompt: 'Unsaved question',
  timerSeconds: 30,
  mediaAssetId: 'question clip',
  revealMediaAssetId: 'reveal clip',
  finalQuestion: false,
  config: { correctAnswer: 'Draft answer' },
  selectedChoiceIndex: null,
}

function categories(patch: Partial<PreviewDraftClue> = {}): PreviewDraftCategory[] {
  return [{ key: 'unsaved-category', title: '', clues: [{ ...clue, ...patch }] }]
}

describe('pack draft preview', () => {
  it('previews the complete Link order manually without a legacy single-song source or a draft mutation', () => {
    const draft = categories({ config: { correctAnswer: 'Connection',
      link: { mediaAssetIds: ['song one', 'two', 'three', 'four'], hintDelaySeconds: 12,
        revealNotes: 'First song - First artist\nSecond song - Second artist' } } })
    const original = structuredClone(draft)
    const preview = clueFromDraft(draft, clue.key, false)
    expect(preview).toMatchObject({ hintDelaySeconds: 12, clue: { type: 'music-free-text', mediaUrl: undefined,
      prompt: 'Unsaved question', link: { hintVisible: true, mediaUrls: [
        '/api/media/song%20one/stream', '/api/media/two/stream', '/api/media/three/stream', '/api/media/four/stream',
      ] }, revealedAnswer: undefined, revealNotes: undefined } })
    expect(clueFromDraft(draft, clue.key, true)?.clue.revealedAnswer).toBe('Connection')
    expect(clueFromDraft(draft, clue.key, true)?.clue.revealNotes)
      .toBe('First song - First artist\nSecond song - Second artist')
    expect(draft).toEqual(original)
    draft[0]!.clues[0]!.config.link!.revealNotes = ' \n '
    expect(clueFromDraft(draft, clue.key, true)?.clue.revealNotes).toBeUndefined()
  })
  it('uses stable unsaved keys and excludes the separate Final Question from board tiles', () => {
    const draft = categories()
    draft[0]!.clues.push({ ...clue, key: 'final', finalQuestion: true })
    expect(boardFromDraft(draft)).toEqual([{
      categoryId: 'unsaved-category', categoryTitle: 'Untitled category', categoryPosition: 0,
      clueId: 'unsaved-clue', boardValue: 200, cluePosition: 0, clueType: 'music_free_text',
    }])
    expect(clueFromDraft(draft, 'final', true)).toMatchObject({
      finalQuestion: true, clue: { id: 'final', prompt: 'Unsaved question', revealedAnswer: 'Draft answer' },
    })
    expect(clueFromDraft(draft, 'removed', false)).toBeNull()
  })

  it('maps current media and hides answers and GIFs until reveal without changing the draft', () => {
    const gif = { provider: 'url' as const, url: 'https://example.com/a.gif',
      previewUrl: 'https://example.com/a.gif', sourceUrl: 'https://example.com', alt: 'Celebration' }
    const questionGif = { ...gif, url: 'https://example.com/question.gif', alt: 'Question' }
    const draft = categories({ config: { correctAnswer: 'New answer', revealGif: gif, questionGif,
      mediaPlayback: { delaySeconds: 2, playCount: 3 }, revealMediaPlayback: { delaySeconds: 1, playCount: 1 } } })
    const original = structuredClone(draft)
    expect(clueFromDraft(draft, clue.key, false)?.clue).toMatchObject({
      prompt: 'Unsaved question', mediaUrl: '/api/media/question%20clip/stream',
      revealMediaUrl: '/api/media/reveal%20clip/stream', revealedAnswer: undefined, revealGif: undefined,
      questionGif,
      mediaPlayback: { delaySeconds: 2, playCount: 3 }, revealMediaPlayback: { delaySeconds: 1, playCount: 1 },
    })
    expect(clueFromDraft(draft, clue.key, true)?.clue).toMatchObject({
      revealedAnswer: 'New answer', revealGif: gif, questionGif: undefined,
    })
    expect(draft).toEqual(original)
  })

  it('reveals the selected multiple-choice row rather than a stale saved answer', () => {
    const draft = categories({
      type: 'music_multiple_choice', selectedChoiceIndex: 1,
      config: { choices: ['Old label', 'Renamed selection'], correctAnswer: 'Old label' },
    })
    expect(clueFromDraft(draft, clue.key, true)?.clue.revealedAnswer).toBe('Renamed selection')
    draft[0]!.clues[0]!.selectedChoiceIndex = null
    expect(clueFromDraft(draft, clue.key, true)?.clue.revealedAnswer).toBeUndefined()
    draft[0]!.clues[0]!.selectedChoiceIndex = 5
    expect(clueFromDraft(draft, clue.key, true)?.clue.revealedAnswer).toBeUndefined()
  })

  it('formats zero price answers with the configured prefix and does not invent missing answers', () => {
    expect(clueFromDraft(categories({
      type: 'price_slider', config: { correctPrice: 0, prefix: 'EUR ' },
    }), clue.key, true)?.clue.revealedAnswer).toBe('EUR 0')
    for (const correctPrice of [undefined, NaN, Infinity]) {
      expect(clueFromDraft(categories({
        type: 'price_slider', config: { correctPrice },
      }), clue.key, true)?.clue.revealedAnswer).toBeUndefined()
    }
    expect(clueFromDraft(categories({ config: { correctAnswer: '  ' } }), clue.key, true)?.clue.revealedAnswer).toBeUndefined()
  })
})
