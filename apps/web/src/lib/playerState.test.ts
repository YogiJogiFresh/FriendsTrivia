import { expect, it } from 'vitest'
import type { RawSnapshot } from './snapshot'
import { answerScope, hasAnswer, playerSnapshot } from './playerState'

const snapshot = { code: 'ROOM', roomGeneration: 'generation', stateVersion: 4, snapshotSequence: 10,
  attempt: 2, window: 3, activeClue: { id: 'clue' } } as RawSnapshot

it('rejects stale bootstrap/broadcast state but accepts newer authoritative state', () => {
  expect(playerSnapshot(snapshot, { ...snapshot, stateVersion: 3, snapshotSequence: 11 })).toBe(snapshot)
  expect(playerSnapshot(snapshot, { ...snapshot, snapshotSequence: 9 })).toBe(snapshot)
  expect(playerSnapshot(snapshot, { ...snapshot, roomGeneration: 'old' })).toBe(snapshot)
  expect(playerSnapshot(snapshot, { ...snapshot, code: 'OTHER' })).toBe(snapshot)
  expect(playerSnapshot(snapshot, { ...snapshot, stateVersion: 5 }).stateVersion).toBe(5)
})

it('preserves accepted answers across windows but not a new attempt or room', () => {
  const receipt = { roomGeneration: 'generation', clueId: 'clue', attempt: 2, window: 3 }
  const resumed = { ...snapshot, window: 5, deadline: 'new-deadline' }
  expect(answerScope(resumed)).toBe(answerScope(snapshot))
  expect(hasAnswer(resumed, receipt)).toBe(true)
  expect(hasAnswer({ ...snapshot, attempt: 3 }, receipt)).toBe(false)
  expect(hasAnswer({ ...snapshot, roomGeneration: 'other' }, receipt)).toBe(false)
})
