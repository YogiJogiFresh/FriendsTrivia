import { describe, expect, it } from 'vitest'
import { assertGamePhaseTransition, isGamePhaseTransitionAllowed } from './game-state.js'

describe('game phase transitions', () => {
  it('allows the normal clue lifecycle and explicit skip paths', () => {
    expect(isGamePhaseTransitionAllowed('LOBBY', 'BOARD')).toBe(true)
    expect(isGamePhaseTransitionAllowed('BOARD', 'CLUE_READY')).toBe(true)
    expect(isGamePhaseTransitionAllowed('CLUE_READY', 'ACCEPTING_ANSWERS')).toBe(true)
    expect(isGamePhaseTransitionAllowed('ACCEPTING_ANSWERS', 'ANSWERS_CLOSED')).toBe(true)
    expect(isGamePhaseTransitionAllowed('ANSWERS_CLOSED', 'REVEAL')).toBe(true)
    expect(isGamePhaseTransitionAllowed('REVEAL', 'LEADERBOARD')).toBe(true)
    expect(isGamePhaseTransitionAllowed('CLUE_READY', 'BOARD')).toBe(true)
  })

  it('only resumes a pause into the recorded prior phase', () => {
    expect(isGamePhaseTransitionAllowed('ACCEPTING_ANSWERS', 'PAUSED')).toBe(true)
    expect(isGamePhaseTransitionAllowed('PAUSED', 'ACCEPTING_ANSWERS', 'ACCEPTING_ANSWERS')).toBe(
      true,
    )
    expect(isGamePhaseTransitionAllowed('PAUSED', 'BOARD', 'ACCEPTING_ANSWERS')).toBe(false)
    expect(isGamePhaseTransitionAllowed('PAUSED', 'BOARD')).toBe(false)
  })

  it('rejects invalid transitions', () => {
    expect(isGamePhaseTransitionAllowed('LOBBY', 'REVEAL')).toBe(false)
    expect(() => assertGamePhaseTransition('FINISHED', 'BOARD')).toThrow(
      'Invalid game phase transition',
    )
  })
})
