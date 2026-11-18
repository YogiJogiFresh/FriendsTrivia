import { describe, expect, it } from 'vitest'
import { answerBreakdownFromSnapshot } from './answerBreakdown'
import type { RawSnapshot, RawResult } from './snapshot'

const players = ['Alex', 'Sam', 'Jo', 'Lee'].map((nickname, index) => ({
  playerId: `p${index}`, nickname, score: 0, teamName: 'Blue', connected: index !== 1,
}))
const snapshot: RawSnapshot = {
  code: 'ROOM', phase: 'LEADERBOARD', joinUrl: '', stateVersion: 1, joiningLocked: true,
  usedClueIds: [], board: [], players,
  activeClue: { id: 'clue', categoryId: 'category', type: 'music_multiple_choice', boardValue: 100,
    prompt: '', timerSeconds: 30, choices: ['First', 'Second', 'Third'] },
}
const result = (playerId: string, answer: unknown, evaluation: unknown = null): RawResult => ({
  playerId, answer: JSON.stringify(answer), evaluation: evaluation === null ? null : JSON.stringify(evaluation),
  correct: 0, rank: null, pointsAwarded: 0,
})

describe('leaderboard answer breakdown', () => {
  it('counts once per eligible seat, including disconnected seats, with zero choices and No answer', () => {
    expect(answerBreakdownFromSnapshot({ ...snapshot, results: [
      result('p0', 'First'), result('p0', 'Second'), result('p1', 'Second'),
      result('p2', null, { answered: false }), result('kicked', 'First'),
    ] })).toEqual({ kind: 'multiple-choice', total: 4, choices: [
      { label: 'First', count: 1, percentage: 25 }, { label: 'Second', count: 1, percentage: 25 },
      { label: 'Third', count: 0, percentage: 0 }, { label: 'No answer', count: 2, percentage: 50 },
    ] })
  })

  it('keeps unmatched legacy answers in totals and never double-counts duplicate labels', () => {
    const breakdown = answerBreakdownFromSnapshot({ ...snapshot,
      activeClue: { ...snapshot.activeClue!, choices: ['First', 'First', 'Second'] },
      players: players.slice(0, 3), results: [
        result('p0', 'First'), result('p1', 'Unexpected'), { ...result('p2', null), answer: 'invalid JSON' },
      ] })
    expect(breakdown).toEqual({ kind: 'multiple-choice', total: 3, choices: [
      { label: 'First', count: 1, percentage: 33 }, { label: 'Second', count: 0, percentage: 0 },
      { label: 'Other answer', count: 1, percentage: 33 }, { label: 'No answer', count: 1, percentage: 33 },
    ] })
  })

  it('preserves exact named Link/Final text without mistaking synthetic awards for answers', () => {
    const answer = '  <strong>Song</strong>\nArtist  '
    const breakdown = answerBreakdownFromSnapshot({ ...snapshot, finalRound: true,
      activeClue: { ...snapshot.activeClue!, type: 'music_free_text',
        link: { mediaUrls: [], hintVisible: true } },
      results: [result('p0', answer), { ...result('p1', null, { answered: false }), correct: 1, pointsAwarded: 200 },
        { ...result('p2', 'Wrong'), pointsAwarded: -100 }],
    })
    expect(breakdown).toEqual({ kind: 'free-text', total: 4, responses: [
      { playerId: 'p0', nickname: 'Alex', answer },
      { playerId: 'p1', nickname: 'Sam', answer: null },
      { playerId: 'p2', nickname: 'Jo', answer: 'Wrong' },
      { playerId: 'p3', nickname: 'Lee', answer: null },
    ] })
  })

  it('restricts Forced Player participation and handles a missing selected seat', () => {
    const forced: RawSnapshot = { ...snapshot, forcedPlayerId: 'p1',
      activeClue: { ...snapshot.activeClue!, type: 'music_free_text', special: 'forced_player' },
      results: [result('p0', null, { awardedBecauseForcedPlayerMissed: true }), result('p1', 'Wrong')],
    }
    expect(answerBreakdownFromSnapshot(forced)).toEqual({ kind: 'free-text', total: 1,
      responses: [{ playerId: 'p1', nickname: 'Sam', answer: 'Wrong' }] })
    expect(answerBreakdownFromSnapshot({ ...forced, forcedPlayerId: 'missing' }))
      .toEqual({ kind: 'free-text', total: 0, responses: [] })
  })

  it('handles no answers or no players without invalid percentages', () => {
    const noAnswers = answerBreakdownFromSnapshot({ ...snapshot, results: [] })
    expect(noAnswers?.kind === 'multiple-choice' && noAnswers.choices.at(-1))
      .toEqual({ label: 'No answer', count: 4, percentage: 100 })
    expect(answerBreakdownFromSnapshot({ ...snapshot, players: [], results: [] })).toEqual({
      kind: 'multiple-choice', total: 0, choices: ['First', 'Second', 'Third', 'No answer']
        .map(label => ({ label, count: 0, percentage: 0 })),
    })
  })

  it('does not publish UI breakdowns before leaderboard, for price, or without settled context', () => {
    for (const phase of ['ACCEPTING_ANSWERS', 'ANSWERS_CLOSED', 'REVEAL', 'FINAL_WAGER', 'BOARD', 'PAUSED', 'FINISHED'] as const) {
      expect(answerBreakdownFromSnapshot({ ...snapshot, phase, results: [result('p0', 'First')] })).toBeUndefined()
    }
    expect(answerBreakdownFromSnapshot({ ...snapshot, results: undefined })).toBeUndefined()
    expect(answerBreakdownFromSnapshot({ ...snapshot, activeClue: undefined, results: [] })).toBeUndefined()
    expect(answerBreakdownFromSnapshot({ ...snapshot,
      activeClue: { ...snapshot.activeClue!, type: 'price_slider' }, results: [] })).toBeUndefined()
  })
})
