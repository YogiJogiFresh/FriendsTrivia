import { describe, expect, it } from 'vitest'
import {
  ActivePublicClueSchema,
  AnswerAcknowledgementSchema,
  DEFAULT_GAME_SETTINGS,
  GameSettingsSchema,
  PackManifestSchema,
  RelativeContentPathSchema,
} from './contracts.js'

const validManifest = {
  schemaVersion: 1,
  pack: {
    key: 'party-night',
    title: 'Party Night',
    categories: [
      {
        key: 'songs',
        title: 'Songs',
        position: 0,
        clues: [
          {
            key: 'song-100',
            type: 'MUSIC_MULTIPLE_CHOICE',
            boardValue: 100,
            position: 0,
            prompt: 'Name this song',
            media: { path: 'songs/example.mp3' },
            choices: [
              { id: 'a', label: 'First' },
              { id: 'b', label: 'Second' },
            ],
            correctChoiceId: 'a',
          },
        ],
      },
    ],
  },
} as const

describe('shared contract schemas', () => {
  it('parses a manifest and supplies pragmatic defaults', () => {
    const manifest = PackManifestSchema.parse(validManifest)

    expect(manifest.pack.defaultSettings).toEqual(DEFAULT_GAME_SETTINGS)
    expect(manifest.pack.categories[0]?.clues[0]).toMatchObject({
      startOffsetSeconds: 0,
      playbackDurationSeconds: 30,
    })
  })

  it('rejects a multiple-choice answer key that is not an option', () => {
    const invalid = {
      ...structuredClone(validManifest),
      pack: {
        ...structuredClone(validManifest.pack),
        categories: [
          {
            ...structuredClone(validManifest.pack.categories[0]),
            clues: [
              {
                ...structuredClone(validManifest.pack.categories[0].clues[0]),
                correctChoiceId: 'missing',
              },
            ],
          },
        ],
      },
    }

    expect(PackManifestSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects duplicate category positions and normalized free-text answers', () => {
    const invalid = {
      ...structuredClone(validManifest),
      pack: {
        ...structuredClone(validManifest.pack),
        categories: [
          structuredClone(validManifest.pack.categories[0]),
          {
            key: 'more-songs',
            title: 'More songs',
            position: 0,
            clues: [
              {
                key: 'free-100',
                type: 'MUSIC_FREE_TEXT',
                boardValue: 100,
                position: 0,
                prompt: 'Name it',
                media: { path: 'songs/example.mp3' },
                acceptedAnswers: ['Hello!', 'hello'],
              },
            ],
          },
        ],
      },
    }

    expect(PackManifestSchema.safeParse(invalid).success).toBe(false)
  })

  it('allows safe nested paths and rejects absolute or traversing paths', () => {
    expect(RelativeContentPathSchema.safeParse('songs/round-1/song.mp3').success).toBe(true)
    expect(RelativeContentPathSchema.safeParse('../secret.txt').success).toBe(false)
    expect(RelativeContentPathSchema.safeParse('songs\\..\\secret.txt').success).toBe(false)
    expect(RelativeContentPathSchema.safeParse('C:\\secret.txt').success).toBe(false)
  })

  it('does not allow the target price into a public price clue', () => {
    const result = ActivePublicClueSchema.safeParse({
      id: 'clue-1',
      categoryId: 'category-1',
      type: 'PRICE_SLIDER',
      boardValue: 500,
      prompt: 'How much?',
      timerSeconds: 30,
      openedAtMs: null,
      deadlineMs: null,
      slider: { min: 0, max: 100, step: 1 },
      targetPrice: 42,
    })

    expect(result.success).toBe(false)
  })

  it('enforces consistent answer acknowledgements', () => {
    expect(
      AnswerAcknowledgementSchema.safeParse({
        requestId: 'request-1',
        accepted: false,
        status: 'REJECTED',
      }).success,
    ).toBe(false)
    expect(
      AnswerAcknowledgementSchema.safeParse({
        requestId: 'request-1',
        accepted: true,
        status: 'ACCEPTED',
        receivedAtMs: 100,
      }).success,
    ).toBe(true)
  })

  it('requires either no teams or uniquely named teams', () => {
    expect(GameSettingsSchema.safeParse({ teams: [] }).success).toBe(true)
    expect(GameSettingsSchema.safeParse({ teams: ['Red', 'Blue'] }).success).toBe(true)
    expect(GameSettingsSchema.safeParse({ teams: ['Red'] }).success).toBe(false)
    expect(GameSettingsSchema.safeParse({ teams: ['Red', 'red'] }).success).toBe(false)
  })

  it('accepts only unique supported clue specials', () => {
    expect(
      GameSettingsSchema.safeParse({
        specials: ['double_points', 'double_or_nothing', 'speed_round', 'forced_player'],
      }).success,
    ).toBe(true)
    expect(
      GameSettingsSchema.safeParse({ specials: ['double_points', 'double_points'] }).success,
    ).toBe(false)
    expect(GameSettingsSchema.safeParse({ specials: ['mystery_special'] }).success).toBe(false)
  })
})
