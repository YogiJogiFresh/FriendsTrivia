import { describe, expect, it } from 'vitest'
import { applyAnswerProgress, expectedRoomContext, roomFromSnapshot, type RawSnapshot } from './snapshot'

const snapshot: RawSnapshot = {
  code: 'ABC123',
  joinUrl: 'https://example.com/play/ABC123',
  phase: 'LOBBY',
  stateVersion: 7,
  roomGeneration: 'room-generation',
  attempt: 3,
  window: 4,
  wagerGeneration: 2,
  joiningLocked: false,
  usedClueIds: [],
  board: [],
  players: [],
}

describe('expectedRoomContext', () => {
  it('carries the authoritative room and attempt context into mutations', () => {
    expect(expectedRoomContext(snapshot)).toEqual({
      expectedStateVersion: 7,
      expectedRoomGeneration: 'room-generation',
      expectedAttempt: 3,
      expectedWindow: 4,
      expectedWagerGeneration: 2,
    })

  })

  it('uses the latest generations after a reset or replacement', () => {
    const next = {
      ...snapshot,
      stateVersion: 8,
      roomGeneration: 'replacement-generation',
      attempt: 4,
      window: 5,
      wagerGeneration: 3,
    }
    expect(expectedRoomContext(next)).toEqual({
      expectedStateVersion: 8,
      expectedRoomGeneration: 'replacement-generation',
      expectedAttempt: 4,
      expectedWindow: 5,
      expectedWagerGeneration: 3,
    })
    expect(expectedRoomContext(snapshot).expectedAttempt).toBe(3)
  })

  it('does not invent an authoritative context before a snapshot arrives', () => {
    expect(Object.values(expectedRoomContext(null))).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ])
  })
})

describe('answer progress', () => {
  const active = { ...snapshot, phase: 'ACCEPTING_ANSWERS' as const, snapshotSequence: 10 }
  const update = { ...active, snapshotSequence: 11, answerProgress: { answered: 2, total: 2 } }

  it('merges aggregate progress without replacing board data or leaking private submissions', () => {
    const next = applyAnswerProgress(active, update)!
    expect(next.board).toBe(active.board)
    expect(roomFromSnapshot(next).answerProgress).toEqual({ answered: 2, total: 2 })
    expect(next).not.toHaveProperty('submissions')
  })

  it('rejects stale progress, other rooms, and previous clue/window generations', () => {
    for (const change of [
      { snapshotSequence: 9 }, { snapshotSequence: 10 }, { code: 'OTHER' },
      { roomGeneration: 'old' }, { attempt: 2 }, { window: 3 },
      { stateVersion: 6 }, { clueId: 'old-clue' }, { phase: 'ANSWERS_CLOSED' as const },
    ]) expect(applyAnswerProgress(active, { ...update, ...change })).toBe(active)
    expect(applyAnswerProgress(null, update)).toBeNull()
  })
})
