import { expect, it } from 'vitest'
import { commandObserved } from './hostCommands'

it('requires a later authoritative snapshot in the same room generation', () => {
  const receipt = { roomGeneration: 'room-a', stateVersion: 4, snapshotSequence: 10 }
  expect(commandObserved(null, receipt)).toBe(false)
  expect(commandObserved(receipt, receipt)).toBe(false)
  expect(commandObserved({ ...receipt, snapshotSequence: 11, stateVersion: 3 }, receipt)).toBe(false)
  expect(commandObserved({ ...receipt, snapshotSequence: 11, roomGeneration: 'room-b' }, receipt)).toBe(false)
  expect(commandObserved({ ...receipt, snapshotSequence: 11 }, receipt)).toBe(true)
})
