import Fastify from 'fastify'
import { io, type Socket } from 'socket.io-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openDatabase } from './database.js'
import { GameEngine } from './game/engine.js'
import { PackRepository } from './repositories/packs.js'
import { RoomRepository } from './repositories/rooms.js'
import { registerSocketServer } from './socket.js'
import { createCosmosStore } from './cloud/cosmos.js'
import { FakeCosmos } from './cloud/cosmosFake.testSupport.js'
import { createId } from './ids.js'
import type { CosmosRooms } from './cloud/cosmosRooms.js'

const clients: Socket[] = []
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect()
  for (const close of cleanup.splice(0)) await close()
  vi.restoreAllMocks()
})

async function fixture(cloud = false) {
  const database = openDatabase(':memory:')
  const source = cloud ? await createCosmosStore(new FakeCosmos(), new FakeCosmos()) : database
  const packs = new PackRepository(source)
  const rooms = new RoomRepository(source)
  const pack = await packs.create({ title: 'Socket test' }) as { id: string }
  const saved = await packs.replace(pack.id, {
    title: 'Socket test', status: 'ready',
    categories: [{
      title: 'Prices', clues: [{
        type: 'price_slider', boardValue: 100, prompt: 'Price?',
        config: { correctPrice: 50, min: 0, max: 100 },
      }]
    }],
  }) as { categories: Array<{ clues: Array<{ id: string }> }> }
  const created = await rooms.create(pack.id, {
    timerSeconds: 30, speedBonusMax: 100,
    priceRankPercentages: [1], uniqueNicknames: true,
  }, 4)
  const engine = new GameEngine(source, rooms, 'https://trivia.example')
  const app = Fastify()
  const server = registerSocketServer(app, rooms, engine, 'https://trivia.example')
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  cleanup.push(async () => {
    engine.dispose()
    await app.close()
    await rooms.drain()
    if (cloud) await (source as Awaited<ReturnType<typeof createCosmosStore>>).close()
    database.close()
  })
  async function client(origin = 'https://trivia.example') {
    const socket = io(address, {
      transports: ['websocket'], forceNew: true,
      extraHeaders: { Origin: origin },
    })
    clients.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
    })
    return socket
  }
  return { ...created, engine, rooms, client, server, clueId: saved.categories[0]!.clues[0]!.id }
}

type Ack<T = { phase: string; stateVersion: number; receivedAt?: string }> = { ok: boolean; error?: string; code?: string; data?: T }
const emit = <T = { phase: string; stateVersion: number; receivedAt?: string }>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> =>
  socket.timeout(2000).emitWithAck(event, payload && typeof payload === 'object'
    ? { requestId: createId(), ...payload } : payload) as Promise<Ack<T>>
type PlayerSnapshot = Awaited<ReturnType<GameEngine['publicSnapshot']>> & {
  ownSubmission?: { clueId: string; attempt: number; window: number; roomGeneration: string }
}
type Joined = { playerId: string; reconnectToken: string; snapshot: PlayerSnapshot }
type Recovery = { id: string; nickname: string; status: string }
type Approved = Joined & { id: string; nickname: string }
async function disconnected(game: Awaited<ReturnType<typeof fixture>>, playerId: string) {
  await vi.waitFor(async () => expect((await game.rooms.scores(game.room.id)).find((player) => player.playerId === playerId)?.connected).toBe(false))
}

describe('socket persistence acknowledgements', () => {
  it('detects lost membership and rejects unauthenticated, replaced-generation, and unowned cursors', async () => {
    const game = await fixture()
    const client = await game.client()
    let snapshot: PlayerSnapshot | undefined
    client.on('room:snapshot', next => { snapshot = next })
    const joined = (await emit<Joined>(client, 'player:join', { code: game.room.code, nickname: 'Player' })).data!
    await vi.waitFor(() => expect(snapshot).toBeDefined())
    const cursor = () => ({ roomGeneration: snapshot!.roomGeneration,
      stateVersion: snapshot!.stateVersion, snapshotSequence: snapshot!.snapshotSequence })
    const server = game.server.sockets.sockets.get(client.id!)!
    await server.leave(`room:${game.room.id}`)
    expect((await emit(client, 'player:sync', cursor())).data).toEqual({ inSync: false })
    const restored = await emit<PlayerSnapshot>(client, 'player:reconnect', {
      code: game.room.code, playerId: joined.playerId, reconnectToken: joined.reconnectToken,
    })
    expect(restored.ok).toBe(true)
    expect(server.rooms.has(`room:${game.room.id}`)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 260))
    expect((await emit(client, 'player:sync', cursor())).data).toEqual({ inSync: true })
    await new Promise(resolve => setTimeout(resolve, 260))
    expect((await emit(client, 'player:sync', { ...cursor(), roomGeneration: 'replaced' })).data).toEqual({ inSync: false })
    await new Promise(resolve => setTimeout(resolve, 260))
    const playerId = server.data.playerId
    server.data.playerId = 'not-owner'
    expect((await emit(client, 'player:sync', cursor())).data).toEqual({ inSync: false })
    server.data.playerId = playerId
    const anonymous = await game.client()
    expect((await emit(anonymous, 'player:sync', cursor())).data).toEqual({ inSync: false })
  })

  it('checks 50 player cursors without SDK reads, snapshots, writes, or public private-receipt data', async () => {
    const game = await fixture(true)
    const players: Array<{ socket: Socket; snapshot: PlayerSnapshot }> = []
    for (let i = 0; i < 50; i++) {
      const socket = await game.client()
      const joined = await emit<Joined>(socket, 'player:join', { code: game.room.code, nickname: `Player ${i}` })
      const player = { socket, snapshot: joined.data!.snapshot }
      socket.on('room:snapshot', next => { player.snapshot = next })
      players.push(player)
    }
    await vi.waitFor(() => expect(players.every(player => player.snapshot.players.length === 50)).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 100))
    const access = (game.rooms.store as CosmosRooms).access
    const read = vi.spyOn(access, 'read'), query = vi.spyOn(access, 'query'), batch = vi.spyOn(access, 'batch')
    const snapshots = vi.spyOn(game.engine, 'snapshotPair')
    const publicSnapshot = vi.spyOn(game.engine, 'publicSnapshot'), hostSnapshot = vi.spyOn(game.engine, 'hostSnapshot')
    const broadcast = vi.fn()
    for (const player of players) player.socket.on('room:snapshot', broadcast)
    const responses = await Promise.all(players.map(player => emit<{ inSync: boolean }>(player.socket, 'player:sync', {
      roomGeneration: player.snapshot.roomGeneration, stateVersion: player.snapshot.stateVersion,
      snapshotSequence: player.snapshot.snapshotSequence,
    })))
    expect(responses.every(response => response.ok && response.data?.inSync)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 260))
    const player = players[0]!
    const stale = await emit<{ inSync: boolean }>(player.socket, 'player:sync', {
      roomGeneration: player.snapshot.roomGeneration, stateVersion: player.snapshot.stateVersion, snapshotSequence: 0,
    })
    expect(stale.data).toEqual({ inSync: false })
    expect(read).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
    expect(snapshots).not.toHaveBeenCalled()
    expect(publicSnapshot).not.toHaveBeenCalled()
    expect(hostSnapshot).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(responses[0]!.data).toEqual({ inSync: true })
    expect(player.snapshot).not.toHaveProperty('ownSubmission')
  })

  it('builds no command snapshot and releases only a minimal committed receipt before the authoritative broadcast', async () => {
    const game = await fixture(true)
    const guest = await game.client()
    await emit(guest, 'player:join', { code: game.room.code, nickname: 'Alex' })
    const host = await game.client()
    await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })
    await new Promise(resolve => setTimeout(resolve, 150))
    const snapshots: PlayerSnapshot[] = []
    host.on('host:snapshot', snapshot => snapshots.push(snapshot))
    const builds = vi.spyOn(game.engine, 'snapshotPair')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const commit = game.rooms.store.commit.bind(game.rooms.store)
    const commits = vi.spyOn(game.rooms.store, 'commit').mockImplementationOnce(async command => {
      await gate
      return commit(command)
    })
    let acknowledged = false
    const pending = emit<ReturnType<GameEngine['commandReceipt']>>(host, 'host:command', {
      command: 'start', expectedRoomGeneration: game.room.ref.generation, expectedAttempt: 0, expectedWindow: 0,
    })
      .then(result => { acknowledged = true; return result })
    try {
      await vi.waitFor(() => expect(commits).toHaveBeenCalledTimes(1))
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(acknowledged).toBe(false)
      expect(builds).not.toHaveBeenCalled()
      expect(snapshots).toHaveLength(0)
    } finally { release() }
    const result = await pending
    expect(result.ok).toBe(true)
    expect(Object.keys(result.data!).sort()).toEqual(['phase', 'roomGeneration', 'snapshotSequence', 'stateVersion'])
    expect(result.data!.stateVersion).toBe((await game.rooms.getById(game.room.id))!.stateVersion)
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    expect(builds).toHaveBeenCalledTimes(1)
    expect(snapshots[0]!.snapshotSequence).toBeGreaterThan(result.data!.snapshotSequence)
  })

  it('does not acknowledge or publish a rejected host mutation as successful', async () => {
    const game = await fixture()
    const guest = await game.client()
    await emit(guest, 'player:join', { code: game.room.code, nickname: 'Alex' })
    const host = await game.client()
    await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })
    await new Promise(resolve => setTimeout(resolve, 150))
    const receipt = vi.spyOn(game.engine, 'commandReceipt')
    const snapshots = vi.fn()
    host.on('host:snapshot', snapshots)
    vi.spyOn(game.rooms.store, 'commit').mockRejectedValueOnce(new Error('Storage unavailable'))
    expect((await emit(host, 'host:command', { command: 'start' })).ok).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(receipt).not.toHaveBeenCalled()
    expect(snapshots).not.toHaveBeenCalled()
    expect((await game.rooms.getById(game.room.id))!.state.phase).toBe('LOBBY')
  })

  it('publishes small coalesced progress for 50 players without a host or per-viewer board reads', async () => {
    const game = await fixture(true)
    const players = await Promise.all(Array.from({ length: 50 }, () => game.client()))
    for (const [index, player] of players.entries())
      expect((await emit(player, 'player:join', { code: game.room.code, nickname: `Player ${index}` })).ok).toBe(true)
    const watcher = await game.client()
    await emit(watcher, 'room:watch', { code: game.room.code })
    let room = await game.engine.startGame(game.room)
    room = await game.engine.selectClue(room, game.clueId)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const progress: Array<{ answerProgress: { answered: number; total: number } }> = []
    const fullSnapshots: unknown[] = []
    watcher.on('room:answer-progress', (next) => progress.push(next))
    watcher.on('room:snapshot', (next) => fullSnapshots.push(next))
    const boardReads = vi.spyOn(game.rooms.store, 'board')
    const submissionReads = vi.spyOn(game.rooms.store, 'submissions')
    const answers = await Promise.all(players.map((player) =>
      emit(player, 'player:answer', { answer: 50,
        expectedRoomGeneration: room.ref.generation, expectedAttempt: room.state.attempt,
        expectedWindow: room.state.window })))
    expect(answers.filter(({ ok }) => !ok)).toEqual([])
    await vi.waitFor(() => expect(progress.at(-1)?.answerProgress).toEqual({ answered: 50, total: 50 }))
    expect(fullSnapshots).toHaveLength(0)
    expect(boardReads).not.toHaveBeenCalled()
    expect(submissionReads.mock.calls.length).toBeLessThan(10)
    expect(progress.length).toBeLessThan(10)
    for (const next of progress) {
      expect(Object.keys(next).sort()).toEqual([
        'answerProgress', 'attempt', 'clueId', 'code', 'phase',
        'roomGeneration', 'snapshotSequence', 'stateVersion', 'window',
      ])
    }
    expect((await game.engine.publicSnapshot(room)).phase).toBe('ACCEPTING_ANSWERS')
  }, 20000)
  it('shares reconnects still executing on the server instead of queuing another mutation', async () => {
    const game = await fixture()
    const original = await game.client()
    const joined = (await emit<Joined>(original, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    original.disconnect(); await disconnected(game, joined.playerId)
    const returning = await game.client()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const commit = game.rooms.store.commit.bind(game.rooms.store)
    const commits = vi.spyOn(game.rooms.store, 'commit').mockImplementationOnce(async (command) => {
      await gate; return commit(command)
    })
    const payload = { code: game.room.code, playerId: joined.playerId, reconnectToken: joined.reconnectToken }
    const first = emit<PlayerSnapshot>(returning, 'player:reconnect', payload)
    await vi.waitFor(() => expect(commits).toHaveBeenCalledTimes(1))
    const second = emit<PlayerSnapshot>(returning, 'player:reconnect', payload)
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const results = await Promise.all([first, second])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(commits).toHaveBeenCalledTimes(1)
    expect(results[0]!.data).toEqual(results[1]!.data)
  })
  it('releases an old seat when the same socket switches identities', async () => {
    const game = await fixture()
    const guest = await game.client()
    const first = (await emit<Joined>(guest, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const second = (await emit<Joined>(guest, 'player:join', { code: game.room.code, nickname: 'Sam' })).data!
    await disconnected(game, first.playerId)
    expect((await game.rooms.scores(game.room.id)).find(({ playerId }) => playerId === second.playerId)?.connected).toBe(true)
    const returning = await game.client()
    expect((await emit(returning, 'player:reconnect', {
      code: game.room.code, playerId: first.playerId, reconnectToken: first.reconnectToken,
    })).ok).toBe(true)
    guest.disconnect()
    await disconnected(game, second.playerId)
    expect((await game.rooms.scores(game.room.id)).find(({ playerId }) => playerId === first.playerId)?.connected).toBe(true)
  })

  it('allows only the requester to cancel and rejects approval of a canceled request', async () => {
    const game = await fixture()
    const original = await game.client()
    const joined = (await emit<Joined>(original, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    original.disconnect(); await disconnected(game, joined.playerId)
    const requester = await game.client(), other = await game.client(), host = await game.client()
    await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })
    const requested = (await emit<Recovery>(requester, 'player:recover-request', {
      code: game.room.code, nickname: 'Alex', expectedRoomGeneration: game.room.ref.generation,
    })).data!
    await emit(other, 'player:recovery-cancel', { recoveryId: requested.id })
    expect((await emit<Recovery>(requester, 'player:recovery-status', { recoveryId: requested.id })).data?.status).toBe('pending')
    await emit(requester, 'player:recovery-cancel', { recoveryId: requested.id })
    expect((await emit(host, 'host:recovery-decision', {
      recoveryId: requested.id, approved: true, expectedRoomGeneration: game.room.ref.generation,
    })).ok).toBe(false)
    expect((await game.rooms.reconnect(game.room, joined.playerId, joined.reconnectToken))?.id).toBe(joined.playerId)
  })

  it('releases snapshot pending state after failure so later updates still broadcast', async () => {
    const game = await fixture()
    const guest = await game.client()
    await emit(guest, 'room:watch', { code: game.room.code })
    const pair = vi.spyOn(game.engine, 'snapshotPair').mockRejectedValueOnce(new Error('Temporary read failure'))
    const snapshots: PlayerSnapshot[] = []
    guest.on('room:snapshot', (snapshot: PlayerSnapshot) => snapshots.push(snapshot))
    game.engine.emit('roomUpdated', game.room.id)
    await vi.waitFor(() => expect(pair).toHaveBeenCalledTimes(1))
    game.engine.emit('roomUpdated', game.room.id)
    await vi.waitFor(() => expect(snapshots.length).toBe(1))
    expect(pair).toHaveBeenCalledTimes(2)
  })
  it('keeps all original seats through a concurrent 50-client disconnect/reconnect burst', async () => {
    const game = await fixture()
    const sockets = await Promise.all(Array.from({ length: 50 }, () => game.client()))
    const joined = await Promise.all(sockets.map((socket, index) =>
      emit<Joined>(socket, 'player:join', { code: game.room.code, nickname: `Player ${index}` })))
    expect(joined.every((result) => result.ok)).toBe(true)
    for (const socket of sockets) socket.disconnect()
    await vi.waitFor(async () => expect((await game.rooms.scores(game.room.id)).every((player) => !player.connected)).toBe(true))
    const reconnected = await Promise.all(Array.from({ length: 50 }, () => game.client()))
    const results = await Promise.all(reconnected.map((socket, index) =>
      emit<PlayerSnapshot>(socket, 'player:reconnect', { code: game.room.code,
        playerId: joined[index]!.data!.playerId, reconnectToken: joined[index]!.data!.reconnectToken })))
    expect(results.every((result) => result.ok)).toBe(true)
    const roster = await game.rooms.scores(game.room.id)
    expect(roster.map(({ playerId }) => playerId).sort()).toEqual(joined.map((result) => result.data!.playerId).sort())
    expect(roster.every((player) => player.connected)).toBe(true)
  }, 15_000)
  it('reconnects the original seat with a private current-answer receipt and blocks connected-seat takeover', async () => {
    const game = await fixture()
    const original = await game.client()
    const joined = (await emit<Joined>(original, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    const other = await game.client()
    expect(await emit(other, 'player:reconnect', { code: game.room.code, playerId: joined.playerId, reconnectToken: joined.reconnectToken }))
      .toMatchObject({ ok: false, code: 'seat_connected' })
    let room = await game.engine.startGame(game.room)
    room = await game.engine.selectClue(room, game.clueId)
    await game.engine.submitAnswer(room, joined.playerId, 50)
    original.disconnect(); await disconnected(game, joined.playerId)
    const watcher = await game.client()
    await emit(watcher, 'room:watch', { code: game.room.code })
    const publicSnapshots: PlayerSnapshot[] = []
    watcher.on('room:snapshot', (snapshot: PlayerSnapshot) => publicSnapshots.push(snapshot))
    const restored = await emit<PlayerSnapshot>(other, 'player:reconnect', {
      code: game.room.code, playerId: joined.playerId, reconnectToken: joined.reconnectToken,
    })
    expect(restored).toMatchObject({ ok: true, data: { ownSubmission: {
      clueId: game.clueId, attempt: room.state.attempt, window: room.state.window, roomGeneration: room.ref.generation,
    } } })
    await vi.waitFor(() => expect(publicSnapshots.length).toBeGreaterThan(0))
    expect(publicSnapshots.every((snapshot) => !snapshot.ownSubmission)).toBe(true)
    expect((await game.rooms.scores(game.room.id))[0]?.connected).toBe(true)
  })

  it('approves a same-name Cosmos seat at capacity with joining locked and keeps credentials private', async () => {
    const game = await fixture(true)
    const original = await game.client()
    const joined = (await emit<Joined>(original, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    for (let index = 1; index < 50; index++) await game.rooms.join(game.room, `Player ${index}`)
    await game.engine.adjustScore(game.room, joined.playerId, 123, 'Existing score')
    await game.rooms.setJoiningLocked(game.room.id, true)
    original.disconnect(); await disconnected(game, joined.playerId)
    const host = await game.client()
    await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })
    const requester = await game.client(), viewer = await game.client()
    await emit(requester, 'room:watch', { code: game.room.code })
    await emit(viewer, 'room:watch', { code: game.room.code })
    const leaked = vi.fn()
    viewer.on('host:recovery-requests', leaked)
    host.on('player:recovery-approved', leaked)
    viewer.on('player:recovery-approved', leaked)
    const pending: Recovery[][] = []
    host.on('host:recovery-requests', (requests: Recovery[]) => pending.push(requests))
    const requested = await emit<Recovery>(requester, 'player:recover-request', {
      code: game.room.code, nickname: '  ALEX ', expectedRoomGeneration: game.room.ref.generation,
    })
    expect(requested).toMatchObject({ ok: true, data: { nickname: 'Alex', status: 'pending' } })
    await vi.waitFor(() => expect(pending.at(-1)).toMatchObject([{ id: requested.data!.id }]))
    expect((await emit(viewer, 'player:recovery-status', { recoveryId: requested.data!.id })).ok).toBe(false)
    expect((await emit(viewer, 'host:recovery-decision', {
      recoveryId: requested.data!.id, approved: true, expectedRoomGeneration: game.room.ref.generation,
    })).ok).toBe(false)
    const approved: Approved[] = []
    requester.on('player:recovery-approved', (result: Approved) => approved.push(result))
    const commits = vi.spyOn(game.rooms.store, 'commit')
    const decision = { recoveryId: requested.data!.id, approved: true, expectedRoomGeneration: game.room.ref.generation }
    expect((await emit(host, 'host:recovery-decision', decision)).ok).toBe(true)
    expect((await emit(host, 'host:recovery-decision', decision)).ok).toBe(true)
    await vi.waitFor(() => expect(approved.length).toBe(2))
    expect(approved[0]).toMatchObject({ playerId: joined.playerId, nickname: 'Alex' })
    expect(approved[0]!.reconnectToken).not.toBe(joined.reconnectToken)
    expect(approved[1]!.reconnectToken).toBe(approved[0]!.reconnectToken)
    expect(commits.mock.calls.filter(([command]) => command.change.kind === 'recover')).toHaveLength(1)
    expect(leaked).not.toHaveBeenCalled()
    expect(await game.rooms.scores(game.room.id)).toHaveLength(50)
    expect((await game.rooms.scores(game.room.id))[0]).toMatchObject({ playerId: joined.playerId, score: 123, connected: true })
    expect(await game.rooms.reconnect(game.room, joined.playerId, joined.reconnectToken)).toBeUndefined()
    expect(pending.at(-1)).toEqual([])
    await game.engine.endSession((await game.rooms.getById(game.room.id))!)
    expect(await emit(host, 'host:recovery-decision', decision)).toMatchObject({ ok: false, code: 'room_ended' })
  })

  it('declines recovery and rechecks kicked and ended seats before approval', async () => {
    const game = await fixture()
    const original = await game.client()
    const joined = (await emit<Joined>(original, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    const requester = await game.client(), host = await game.client()
    await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })
    const payload = { code: game.room.code, nickname: 'Alex', expectedRoomGeneration: game.room.ref.generation }
    expect(await emit(requester, 'player:recover-request', payload)).toMatchObject({ ok: false, code: 'seat_connected' })
    original.disconnect(); await disconnected(game, joined.playerId)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const request = (await emit<Recovery>(requester, 'player:recover-request', payload)).data!
    const states: Recovery[] = []
    requester.on('player:recovery-state', (state: Recovery) => states.push(state))
    expect((await emit(host, 'host:recovery-decision', {
      recoveryId: request.id, approved: false, expectedRoomGeneration: game.room.ref.generation,
    })).ok).toBe(true)
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('declined'))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const second = (await emit<Recovery>(requester, 'player:recover-request', payload)).data!
    await game.rooms.kickPlayer(game.room.id, joined.playerId)
    expect((await emit(host, 'host:recovery-decision', {
      recoveryId: second.id, approved: true, expectedRoomGeneration: game.room.ref.generation,
    })).ok).toBe(false)
    const ended = await game.engine.endSession(game.room)
    expect(ended.status).toBe('abandoned')
    const fresh = await game.client()
    expect(await emit(fresh, 'player:recover-request', payload)).toMatchObject({ ok: false, code: 'room_ended' })
  })

  it('expires requests without changing the original seat or token', async () => {
    const game = await fixture()
    const original = await game.client()
    const joined = (await emit<Joined>(original, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    original.disconnect(); await disconnected(game, joined.playerId)
    const requester = await game.client()
    const timeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      timeout(() => callback(...args), delay === 120_000 ? 30 : delay)) as typeof setTimeout)
    const states: Recovery[] = []
    requester.on('player:recovery-state', (state: Recovery) => states.push(state))
    const requested = (await emit<Recovery>(requester, 'player:recover-request', {
      code: game.room.code, nickname: 'Alex', expectedRoomGeneration: game.room.ref.generation,
    })).data!
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('expired'))
    expect((await emit(requester, 'player:recovery-status', { recoveryId: requested.id })).ok).toBe(false)
    expect((await game.rooms.reconnect(game.room, joined.playerId, joined.reconnectToken))?.id).toBe(joined.playerId)
  })

  it('does not hand off or orphan a seat when the requester disconnects during commit', async () => {
    const game = await fixture()
    const original = await game.client()
    const joined = (await emit<Joined>(original, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    original.disconnect(); await disconnected(game, joined.playerId)
    const requester = await game.client(), host = await game.client()
    await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })
    const requested = (await emit<Recovery>(requester, 'player:recover-request', {
      code: game.room.code, nickname: 'Alex', expectedRoomGeneration: game.room.ref.generation,
    })).data!
    let release!: () => void, started = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const commit = game.rooms.store.commit.bind(game.rooms.store)
    vi.spyOn(game.rooms.store, 'commit').mockImplementationOnce(async (command) => {
      started = true; await gate; return commit(command)
    })
    const approved = vi.fn()
    requester.on('player:recovery-approved', approved)
    const decision = emit(host, 'host:recovery-decision', {
      recoveryId: requested.id, approved: true, expectedRoomGeneration: game.room.ref.generation,
    })
    await vi.waitFor(() => expect(started).toBe(true))
    const requests: Recovery[][] = []
    host.on('host:recovery-requests', (pending: Recovery[]) => requests.push(pending))
    requester.disconnect()
    await vi.waitFor(() => expect(requests.at(-1)).toEqual([]))
    release(); await decision
    await disconnected(game, joined.playerId)
    expect(approved).not.toHaveBeenCalled()
    expect(await game.rooms.scores(game.room.id)).toHaveLength(1)
    const fresh = await game.client()
    expect((await emit(fresh, 'player:recover-request', {
      code: game.room.code, nickname: 'Alex', expectedRoomGeneration: game.room.ref.generation,
    })).ok).toBe(true)
  })

  it('never delivers rotated credentials after a failed persistence operation', async () => {
    const game = await fixture()
    const original = await game.client()
    const joined = (await emit<Joined>(original, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    original.disconnect(); await disconnected(game, joined.playerId)
    const requester = await game.client(), host = await game.client()
    await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })
    const requested = (await emit<Recovery>(requester, 'player:recover-request', {
      code: game.room.code, nickname: 'Alex', expectedRoomGeneration: game.room.ref.generation,
    })).data!
    const approved = vi.fn()
    requester.on('player:recovery-approved', approved)
    vi.spyOn(game.rooms.store, 'commit').mockRejectedValueOnce(new Error('Storage unavailable'))
    expect((await emit(host, 'host:recovery-decision', {
      recoveryId: requested.id, approved: true, expectedRoomGeneration: game.room.ref.generation,
    })).ok).toBe(false)
    expect(approved).not.toHaveBeenCalled()
    expect((await game.rooms.reconnect(game.room, joined.playerId, joined.reconnectToken))?.id).toBe(joined.playerId)
  })

  it('coalesces queued and in-flight snapshots and still publishes the latest presence', async () => {
    const game = await fixture()
    const guest = await game.client(), host = await game.client()
    const joined = (await emit<Joined>(guest, 'player:join', { code: game.room.code, nickname: 'Alex' })).data!
    await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })
    await new Promise((resolve) => setTimeout(resolve, 100))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pair = game.engine.snapshotPair.bind(game.engine)
    const builds = vi.spyOn(game.engine, 'snapshotPair').mockImplementationOnce(async (...args) => {
      await gate; return pair(...args)
    })
    const publicBuilds = vi.spyOn(game.engine, 'publicSnapshot')
    const snapshots: PlayerSnapshot[] = []
    guest.on('room:snapshot', (snapshot: PlayerSnapshot) => snapshots.push(snapshot))
    for (let index = 0; index < 50; index++) game.engine.emit('hostUpdated', game.room.id)
    await vi.waitFor(() => expect(builds).toHaveBeenCalledTimes(1))
    const change = game.engine.runRoom(game.room.id, async () => {
      await game.rooms.setConnected(joined.playerId, false)
      game.engine.afterCommit(() => game.engine.emit('roomUpdated', game.room.id))
    })
    for (let index = 0; index < 50; index++) {
      game.engine.emit('roomUpdated', game.room.id)
      game.engine.emit('hostUpdated', game.room.id)
    }
    release(); await change
    await vi.waitFor(() => expect(snapshots.at(-1)?.players[0]?.connected).toBe(false))
    expect(builds).toHaveBeenCalledTimes(2)
    expect(publicBuilds).not.toHaveBeenCalled()
    expect(snapshots.at(-1)?.ownSubmission).toBeUndefined()
  })
  it('rejects cross-origin WebSocket connections before they join a room', async () => {
    const game = await fixture()
    await expect(game.client('https://unrelated.example')).rejects.toThrow()
    const guest = await game.client()
    expect((await emit(guest, 'room:watch', { code: game.room.code })).ok).toBe(true)
  })

  it('acknowledges malformed mutation payloads without crashing the connection', async () => {
    const game = await fixture()
    const guest = await game.client()
    await emit(guest, 'player:join', { code: game.room.code, nickname: 'Alex' })
    for (const event of ['player:answer', 'player:wager', 'player:special-vote', 'host:command']) {
      expect(await emit(guest, event, null)).toMatchObject({
        ok: false, error: expect.any(String),
      })
    }
    expect((await emit(guest, 'room:watch', { code: game.room.code })).ok).toBe(true)
  })

  it('allows public watching/joining, requires creator token and awaits committed host state', async () => {
    const game = await fixture()
    const guest = await game.client()
    expect((await emit(guest, 'room:watch', { code: game.room.code })).data?.phase).toBe('LOBBY')
    expect(await emit(guest, 'host:connect', { code: game.room.code })).toEqual({
      ok: false, error: 'Host authorization failed',
    })
    expect((await emit(guest, 'player:join', { code: game.room.code, nickname: 'Alex' })).ok).toBe(true)
    const host = await game.client()
    expect((await emit(host, 'host:connect', { code: game.room.code, hostToken: game.hostToken })).ok).toBe(true)
    const started = await emit(host, 'host:command', { command: 'start', expectedStateVersion: game.room.stateVersion })
    expect(started.data?.phase).toBe('BOARD')
    expect((await game.rooms.getById(game.room.id))!.stateVersion).toBe(started.data!.stateVersion)
  })

  it('turns asynchronous failures into acknowledgements and persists answer receipts', async () => {
    const game = await fixture()
    const guest = await game.client()
    await emit(guest, 'player:join', { code: game.room.code, nickname: 'Alex' })
    let room = await game.engine.startGame(game.room)
    room = await game.engine.selectClue(room, game.clueId)
    const accepted = await emit(guest, 'player:answer', { answer: 50, expectedStateVersion: room.stateVersion })
    expect(accepted.ok).toBe(true)
    expect(accepted.data?.receivedAt).toEqual(expect.any(String))
    const receipts = (await game.engine.hostSnapshot(room)).submissions
    expect(receipts).toHaveLength(1)
    await game.engine.closeAnswers(room)
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(await emit(guest, 'player:answer', { answer: 50, expectedStateVersion: room.stateVersion })).toEqual({
      ok: false, error: 'Room state changed; refresh and try again',
    })
    expect((await game.engine.hostSnapshot((await game.rooms.getById(room.id))!)).submissions).toHaveLength(1)
  })
  it('rejects old answer generations after reset and accepts the current window', async () => {
    const game = await fixture()
    const guest = await game.client()
    await emit(guest, 'player:join', { code: game.room.code, nickname: 'Alex' })
    let room = await game.engine.startGame(game.room)
    room = await game.engine.selectClue(room, game.clueId)
    const old = {
      expectedRoomGeneration: room.ref.generation, expectedAttempt: room.state.attempt,
      expectedWindow: room.state.window,
    }
    room = await game.engine.resetClue(room)
    expect(await emit(guest, 'player:answer', { answer: 50, ...old })).toEqual({
      ok: false, error: 'This question has changed; refresh and try again',
    })
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect((await emit(guest, 'player:answer', {
      answer: 50, expectedRoomGeneration: room.ref.generation,
      expectedAttempt: room.state.attempt, expectedWindow: room.state.window,
    })).ok).toBe(true)
    expect((await game.engine.hostSnapshot(room)).submissions).toHaveLength(1)
  })
})
