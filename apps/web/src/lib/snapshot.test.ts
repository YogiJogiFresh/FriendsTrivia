import { describe, expect, it } from 'vitest'
import { expectedRoomContext, type RawSnapshot } from './snapshot'

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
