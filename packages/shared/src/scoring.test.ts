import { describe, expect, it } from 'vitest'
import {
  isFreeTextAnswerMatch,
  matchFreeTextAnswer,
  normalizeFreeTextAnswer,
  scoreMusicAnswer,
  scorePriceAnswers,
} from './scoring.js'

describe('free-text answer matching', () => {
  it('case-folds, trims, collapses whitespace, and strips basic punctuation', () => {
    expect(normalizeFreeTextAnswer('  Don’t—Stop,   Me!  ')).toBe('don t stop me')
    expect(isFreeTextAnswerMatch('Bohemian   Rhapsody!', ['Bohemian Rhapsody'])).toBe(true)
  })

  it('remains conservative about accents and spelling', () => {
    expect(isFreeTextAnswerMatch('Beyonce', ['Beyoncé'])).toBe(false)
    expect(isFreeTextAnswerMatch('Beatle', ['The Beatles'])).toBe(false)
  })

  it('never treats punctuation-only input as a match', () => {
    expect(matchFreeTextAnswer('!!!', ['...'])).toEqual({
      matched: false,
      normalizedSubmission: '',
    })
  })
})

describe('music scoring', () => {
  const baseInput = {
    playerId: 'player-1',
    clueId: 'clue-1',
    boardValue: 500,
    correct: true,
    openedAtMs: 1_000,
    deadlineMs: 31_000,
    receivedAtMs: 1_000,
  } as const

  it('awards at most the clue value and degrades linearly to zero', () => {
    expect(scoreMusicAnswer(baseInput)).toMatchObject({
      correct: true,
      onTime: true,
      basePoints: 500,
      speedBonusPoints: 0,
      totalPoints: 500,
    })
    expect(scoreMusicAnswer({ ...baseInput, receivedAtMs: 16_000 })).toMatchObject({
      basePoints: 250,
      speedBonusPoints: 0,
      totalPoints: 250,
    })
    expect(scoreMusicAnswer({ ...baseInput, receivedAtMs: 31_000 })).toMatchObject({
      correct: true,
      onTime: true,
      basePoints: 0,
      speedBonusPoints: 0,
      totalPoints: 0,
    })
  })

  it('gives no points for an incorrect or late answer', () => {
    expect(scoreMusicAnswer({ ...baseInput, correct: false })).toMatchObject({
      correct: false,
      basePoints: 0,
      speedBonusPoints: 0,
      totalPoints: 0,
    })
    expect(scoreMusicAnswer({ ...baseInput, receivedAtMs: 31_001 })).toMatchObject({
      correct: false,
      onTime: false,
      totalPoints: 0,
    })
  })

  it('clamps answers received before the opening time to the clue value', () => {
    expect(scoreMusicAnswer({ ...baseInput, receivedAtMs: 0 })).toMatchObject({
      basePoints: 500,
      totalPoints: 500,
    })
  })
})

describe('ranked price scoring', () => {
  it('uses closest-without-going-over, competition ranks, ties, and zeroed overbids', () => {
    const result = scorePriceAnswers({
      clueId: 'clue-price',
      targetPrice: 100,
      boardValue: 1000,
      answers: [
        { playerId: 'over', guess: 101 },
        { playerId: 'third', guess: 80 },
        { playerId: 'tie-b', guess: 90 },
        { playerId: 'exact', guess: 100 },
        { playerId: 'tie-a', guess: 90 },
      ],
    })

    expect(result.results).toEqual([
      {
        playerId: 'exact',
        guess: 100,
        overbid: false,
        distanceFromTarget: 0,
        rank: 1,
        multiplier: 1,
        points: 1000,
      },
      {
        playerId: 'tie-a',
        guess: 90,
        overbid: false,
        distanceFromTarget: 10,
        rank: 2,
        multiplier: 0.9,
        points: 900,
      },
      {
        playerId: 'tie-b',
        guess: 90,
        overbid: false,
        distanceFromTarget: 10,
        rank: 2,
        multiplier: 0.9,
        points: 900,
      },
      {
        playerId: 'third',
        guess: 80,
        overbid: false,
        distanceFromTarget: 20,
        rank: 4,
        multiplier: 0.8,
        points: 800,
      },
      {
        playerId: 'over',
        guess: 101,
        overbid: true,
        distanceFromTarget: 1,
        rank: null,
        multiplier: 0,
        points: 0,
      },
    ])
  })

  it('uses explicit tie tolerance without chaining nearby distances', () => {
    const result = scorePriceAnswers({
      clueId: 'clue-price',
      targetPrice: 10,
      boardValue: 100,
      settings: {
        rankMultipliers: [1, 0.5, 0.25],
        roundTo: 1,
        tieTolerance: 0.1,
      },
      answers: [
        { playerId: 'a', guess: 9 },
        { playerId: 'b', guess: 8.95 },
        { playerId: 'c', guess: 8.89 },
      ],
    })

    expect(result.results.map(({ playerId, rank }) => ({ playerId, rank }))).toEqual([
      { playerId: 'a', rank: 1 },
      { playerId: 'b', rank: 1 },
      { playerId: 'c', rank: 3 },
    ])
  })

  it('scales points across the configured range and gives overbids zero', () => {
    const result = scorePriceAnswers({
      clueId: 'clue-price',
      targetPrice: 100,
      minimumPrice: 50,
      boardValue: 100,
      settings: { rankMultipliers: [1], roundTo: 1, tieTolerance: 0 },
      answers: [
        { playerId: 'exact', guess: 100 },
        { playerId: 'halfway', guess: 75 },
        { playerId: 'floor', guess: 50 },
        { playerId: 'over', guess: 100.01 },
      ],
    })

    expect(result.results.map(({ playerId, points }) => ({ playerId, points }))).toEqual([
      { playerId: 'exact', points: 100 },
      { playerId: 'halfway', points: 50 },
      { playerId: 'floor', points: 0 },
      { playerId: 'over', points: 0 },
    ])
  })

  it('rejects duplicate player submissions', () => {
    expect(() =>
      scorePriceAnswers({
        clueId: 'clue-price',
        targetPrice: 100,
        boardValue: 100,
        answers: [
          { playerId: 'same', guess: 90 },
          { playerId: 'same', guess: 80 },
        ],
      }),
    ).toThrow(/Duplicate price answer/)
  })
})
