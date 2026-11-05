import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawSnapshot } from '../../lib/snapshot'

// Effects and sockets are driven explicitly; these tests need no DOM dependency.
const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ callback: () => void | (() => void); deps: unknown[]; pending: boolean; cleanup?: () => void }>,
  stateIndex: 0, refIndex: 0, effectIndex: 0,
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  socket: { connected: true, id: 'first', on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  identities: new Map<string, { playerId: string; reconnectToken: string; nickname: string }>(),
  emit: vi.fn(),
  clear: vi.fn(),
}))
vi.mock('react', () => ({
  useState: <T,>(initial?: T) => {
    const index = harness.stateIndex++
    if (!(index in harness.states)) harness.states[index] = initial
    return [harness.states[index], (next: T | ((previous: T) => T)) => {
      harness.states[index] = typeof next === 'function'
        ? (next as (previous: T) => T)(harness.states[index] as T) : next
    }]
  },
  useRef: (initial: unknown) => {
    const index = harness.refIndex++
    return harness.refs[index] ??= { current: initial }
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (callback: () => void | (() => void), deps: unknown[]) => {
    const index = harness.effectIndex++
    const previous = harness.effects[index]
    if (!previous || deps.some((value, offset) => value !== previous.deps[offset])) {
      previous?.cleanup?.()
      harness.effects[index] = { callback, deps, pending: true }
    }
  },
}))
vi.mock('../../lib/socketClient', async (original) => ({
  ...await original<typeof import('../../lib/socketClient')>(),
  getSocket: () => harness.socket,
  emitWithAck: harness.emit,
}))
vi.mock('../../lib/roomStorage', () => ({
  getPlayerIdentity: (code: string) => harness.identities.get(code) ?? null,
  savePlayerIdentity: (code: string, identity: { playerId: string; reconnectToken: string; nickname: string }) =>
    harness.identities.set(code, identity),
  clearPlayerIdentity: (code: string) => { harness.clear(code); harness.identities.delete(code) },
  getHostToken: () => 'host-token',
}))
vi.mock('./useConnectionStatus', () => ({ useConnectionStatus: () => 'connected' }))

import { usePlayerRoom } from './usePlayerRoom'
import { useHostRoom } from './useHostRoom'
import { SocketAckError } from '../../lib/socketClient'

const identity = { playerId: 'alex', reconnectToken: 'original-token', nickname: 'Alex' }
const snapshot: RawSnapshot = {
  code: 'ROOM', joinUrl: 'https://example.test/play/ROOM', phase: 'LOBBY', stateVersion: 0,
  roomGeneration: 'generation', attempt: 1, window: 1, joiningLocked: false,
  board: [], usedClueIds: [], players: [{ playerId: 'alex', nickname: 'Alex', teamName: 'Blue', score: 100, connected: true }],
}
function render<T>(hook: () => T): T {
  harness.stateIndex = harness.refIndex = harness.effectIndex = 0
  const result = hook()
  for (const effect of harness.effects) if (effect.pending) {
    effect.pending = false
    effect.cleanup = effect.callback() || undefined
  }
  return result
}
function event(name: string, ...args: unknown[]) {
  for (const listener of harness.listeners.get(name) ?? []) listener(...args)
}
async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}
beforeEach(() => {
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '' } }))
  harness.states = []; harness.refs = []; harness.effects = []
  harness.listeners.clear(); harness.identities.clear()
  harness.identities.set('ROOM', identity)
  harness.socket.connected = true; harness.socket.id = 'first'
  harness.emit.mockReset().mockResolvedValue(snapshot)
  harness.clear.mockClear()
  harness.socket.emit.mockClear()
  harness.socket.on.mockImplementation((name: string, callback: (...args: unknown[]) => void) => {
    const listeners = harness.listeners.get(name) ?? new Set()
    listeners.add(callback); harness.listeners.set(name, listeners)
  })
  harness.socket.off.mockImplementation((name: string, callback: (...args: unknown[]) => void) =>
    harness.listeners.get(name)?.delete(callback))
})
afterEach(() => {
  for (const effect of harness.effects) effect.cleanup?.()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('player seat recovery', () => {
  it('probes visible tabs without reconnecting, coalesces focus signals, and cleans up on unmount', async () => {
    vi.useFakeTimers()
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    render(() => usePlayerRoom('ROOM')); await settle()
    harness.emit.mockResolvedValue({ inSync: true })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(harness.emit).toHaveBeenLastCalledWith('player:sync', {
      roomGeneration: 'generation', stateVersion: 0, snapshotSequence: undefined,
    })
    expect(render(() => usePlayerRoom('ROOM')).reconnecting).toBe(false)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(harness.emit).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { value: 'visible' })
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
    }
    await settle()
    expect(harness.emit).toHaveBeenCalledTimes(3)
    expect(render(() => usePlayerRoom('ROOM')).reconnecting).toBe(false)
    for (const effect of harness.effects) effect.cleanup?.()
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.emit).toHaveBeenCalledTimes(3)
  })

  it('preserves credentials on timeout and retries without returning to nickname entry', async () => {
    vi.useFakeTimers()
    harness.emit.mockRejectedValueOnce(new SocketAckError('Slow backend', 'timeout'))
    render(() => usePlayerRoom('ROOM')); await settle()
    expect(harness.clear).not.toHaveBeenCalled()
    expect(render(() => usePlayerRoom('ROOM'))).toMatchObject({ reconnecting: true, needsNickname: false, reconnectError: 'Slow backend' })
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.emit).toHaveBeenCalledTimes(2)
    expect(render(() => usePlayerRoom('ROOM'))).toMatchObject({ reconnecting: false, playerId: 'alex', needsNickname: false })
    expect(harness.identities.get('ROOM')).toEqual(identity)
  })

  it('waits for the socket and avoids duplicate initial reconnects', async () => {
    harness.socket.connected = false
    harness.emit.mockReturnValue(new Promise(() => {}))
    render(() => usePlayerRoom('ROOM'))
    expect(harness.emit).not.toHaveBeenCalled()
    harness.socket.connected = true
    event('connect'); event('connect')
    expect(harness.emit).toHaveBeenCalledTimes(1)
  })

  it('keeps unknown failures retryable and caps backoff while pausing offline', async () => {
    vi.useFakeTimers()
    harness.emit.mockRejectedValue(new Error('Uncoded failure'))
    render(() => usePlayerRoom('ROOM')); await settle()
    await vi.advanceTimersByTimeAsync(12_500)
    expect(harness.emit).toHaveBeenCalledTimes(6)
    expect(harness.clear).not.toHaveBeenCalled()
    harness.socket.connected = false; event('disconnect')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(harness.emit).toHaveBeenCalledTimes(6)
  })

  it('only invalidates explicitly rejected identities and keeps kicked players terminal', async () => {
    harness.emit.mockRejectedValueOnce(new SocketAckError('Removed', 'player_kicked'))
    render(() => usePlayerRoom('ROOM')); await settle()
    expect(harness.clear).toHaveBeenCalledWith('ROOM')
    expect(render(() => usePlayerRoom('ROOM'))).toMatchObject({ fatalError: 'Removed', reconnecting: false })
    expect(harness.emit).toHaveBeenCalledTimes(1)
  })
  it('offers nickname recovery after explicit token invalidation and loads the room again', async () => {
    vi.useFakeTimers()
    harness.emit.mockRejectedValueOnce(new SocketAckError('Invalid token', 'invalid_identity'))
    render(() => usePlayerRoom('ROOM')); await settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.clear).toHaveBeenCalledWith('ROOM')
    expect(harness.emit).toHaveBeenLastCalledWith('room:watch', { code: 'ROOM' })
    expect(render(() => usePlayerRoom('ROOM'))).toMatchObject({ needsNickname: true, reconnecting: false, fatalError: null })
  })

  it('cancels pending approval on unmount and ignores the outstanding request result', async () => {
    harness.identities.clear()
    render(() => usePlayerRoom('ROOM')); await settle()
    let resolveRequest!: (request: unknown) => void
    harness.emit.mockReturnValueOnce(new Promise((resolve) => { resolveRequest = resolve }))
    const request = render(() => usePlayerRoom('ROOM')).requestRecovery('Alex')
    const id = harness.emit.mock.calls.at(-1)![1].requestId
    for (const effect of harness.effects) effect.cleanup?.()
    expect(harness.socket.emit).toHaveBeenCalledWith('player:recovery-cancel', { recoveryId: id })
    resolveRequest({ id, nickname: 'Alex', status: 'pending' })
    await request
    expect(harness.emit).toHaveBeenCalledTimes(2)
    expect(harness.identities.size).toBe(0)
  })

  it('ignores failures from an obsolete connection and cleans up retry work on unmount', async () => {
    vi.useFakeTimers()
    let rejectOld!: (error: Error) => void
    harness.emit.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject }))
    render(() => usePlayerRoom('ROOM'))
    harness.socket.connected = false; event('disconnect')
    harness.socket.connected = true; harness.socket.id = 'second'; event('connect')
    await settle()
    rejectOld(new SocketAckError('Old rejection', 'invalid_identity')); await settle()
    expect(harness.clear).not.toHaveBeenCalled()
    expect(render(() => usePlayerRoom('ROOM')).playerId).toBe('alex')
    for (const effect of harness.effects) effect.cleanup?.()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(harness.emit).toHaveBeenCalledTimes(2)
    expect([...harness.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })

  it('accepts private approval even before its request acknowledgement arrives', async () => {
    harness.identities.clear()
    render(() => usePlayerRoom('ROOM')); await settle()
    let resolveRequest!: (request: unknown) => void
    harness.emit.mockReturnValueOnce(new Promise((resolve) => { resolveRequest = resolve }))
    const request = render(() => usePlayerRoom('ROOM')).requestRecovery('Alex')
    const id = harness.emit.mock.calls.at(-1)![1].requestId
    event('player:recovery-approved', { id, ...identity, reconnectToken: 'rotated', snapshot })
    resolveRequest({ id, nickname: 'Alex', status: 'pending' })
    await request; await settle()
    expect(harness.identities.get('ROOM')?.reconnectToken).toBe('rotated')
    expect(render(() => usePlayerRoom('ROOM'))).toMatchObject({ playerId: 'alex', recovery: null, needsNickname: false })
  })

  it('restores an answer receipt across windows but unlocks a new attempt', async () => {
    const activeClue = { id: 'clue', categoryId: 'category', type: 'price_slider' as const, boardValue: 100, prompt: 'Price?', timerSeconds: 30 }
    harness.emit.mockResolvedValue({ ...snapshot, activeClue, ownSubmission: {
      clueId: 'clue', attempt: 1, window: 1, roomGeneration: 'generation',
    } })
    render(() => usePlayerRoom('ROOM')); await settle()
    expect(render(() => usePlayerRoom('ROOM')).answerSubmitted).toBe(true)
    event('room:snapshot', { ...snapshot, activeClue, window: 2 })
    expect(render(() => usePlayerRoom('ROOM')).answerSubmitted).toBe(true)
    event('room:snapshot', { ...snapshot, activeClue, attempt: 2, window: 2, stateVersion: 1 })
    expect(render(() => usePlayerRoom('ROOM')).answerSubmitted).toBe(false)
  })
})

describe('host recovery requests', () => {
  it('subscribes before authenticating and restores the private pending list on reconnect', async () => {
    harness.socket.connected = false
    render(() => useHostRoom('ROOM'))
    expect(harness.emit).not.toHaveBeenCalled()
    harness.socket.connected = true; event('connect')
    const requests = [{ id: 'request', playerId: 'alex', nickname: 'Alex', teamName: 'Blue', score: 100, expiresAt: '2026-11-01T20:00:00Z' }]
    event('host:recovery-requests', requests); await settle()
    expect(render(() => useHostRoom('ROOM')).recoveryRequests).toEqual(requests)
    harness.socket.connected = false; event('disconnect')
    expect(render(() => useHostRoom('ROOM')).recoveryRequests).toEqual([])
    harness.socket.connected = true; event('connect'); event('host:recovery-requests', requests); await settle()
    const host = render(() => useHostRoom('ROOM'))
    expect(host.recoveryRequests).toEqual(requests)
    await host.decideRecovery('request', true)
    expect(harness.emit).toHaveBeenLastCalledWith('host:recovery-decision', {
      recoveryId: 'request', approved: true, expectedRoomGeneration: 'generation',
    })
  })

  it('clears a previous authentication error after a successful reconnect', async () => {
    harness.emit.mockRejectedValueOnce(new Error('Temporary failure'))
    render(() => useHostRoom('ROOM')); await settle()
    expect(render(() => useHostRoom('ROOM')).error).toBe('Temporary failure')
    event('connect'); await settle()
    expect(render(() => useHostRoom('ROOM')).error).toBeNull()
  })
})
