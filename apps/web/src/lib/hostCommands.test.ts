import { expect, it } from 'vitest'
import { commandObserved, nextHostAction } from './hostCommands'
import type { GameState } from '../data/types'

it('requires a later authoritative snapshot in the same room generation', () => {
  const receipt = { roomGeneration: 'room-a', stateVersion: 4, snapshotSequence: 10 }
  expect(commandObserved(null, receipt)).toBe(false)
  expect(commandObserved(receipt, receipt)).toBe(false)
  expect(commandObserved({ ...receipt, snapshotSequence: 11, stateVersion: 3 }, receipt)).toBe(false)
  expect(commandObserved({ ...receipt, snapshotSequence: 11, roomGeneration: 'room-b' }, receipt)).toBe(false)
  expect(commandObserved({ ...receipt, snapshotSequence: 11 }, receipt)).toBe(true)
})

it('offers Final instead of finishing the last ordinary clue, then finishes after Final', () => {
  const game: Pick<GameState, 'room' | 'categories' | 'clues' | 'currentClueId'> = {
    room: { code: 'ROOM', phase: 'LEADERBOARD', joinUrl: '', locked: true, stateVersion: 1,
      finalRound: false, hasFinalQuestion: true, teams: [], specialVotedPlayerIds: [] },
    categories: [{ id: 'category', title: 'Songs', accentToken: '', clueIds: ['last'] }],
    clues: [
      { id: 'last', categoryId: 'category', type: 'music-free-text', value: 100, used: false, prompt: '', timerSeconds: 30 },
      { id: 'final', categoryId: 'category', type: 'music-free-text', value: 0, used: false, prompt: '', timerSeconds: 30 },
    ],
    currentClueId: 'last',
  }
  expect(nextHostAction(game)).toBe('startFinal')
  expect(nextHostAction({ ...game, room: { ...game.room, phase: 'REVEAL' } })).toBe('leaderboard')
  expect(nextHostAction({ ...game, room: { ...game.room, hasFinalQuestion: false } })).toBe('finish')
  const board = { ...game, currentClueId: null, clues: game.clues.map(clue => ({ ...clue, used: true })),
    room: { ...game.room, phase: 'BOARD' as const } }
  expect(nextHostAction(board)).toBe('startFinal')
  expect(nextHostAction({ ...board, categories: [], clues: [] })).toBe('startFinal')
  expect(nextHostAction({ ...game, currentClueId: null })).toBe('board')
  expect(nextHostAction({ ...game, currentClueId: null, room: { ...game.room, finalRound: true } })).toBe('finish')
  expect(nextHostAction({ ...board, room: { ...board.room, finalRound: true } })).toBeUndefined()
  expect(nextHostAction({ ...game, room: { ...game.room, phase: 'FINAL_WAGER' } })).toBeUndefined()
})
