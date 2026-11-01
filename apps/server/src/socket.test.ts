import Fastify from 'fastify'
import { io, type Socket } from 'socket.io-client'
import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from './database.js'
import { GameEngine } from './game/engine.js'
import { PackRepository } from './repositories/packs.js'
import { RoomRepository } from './repositories/rooms.js'
import { registerSocketServer } from './socket.js'

const clients: Socket[] = []
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect()
  for (const close of cleanup.splice(0)) await close()
})

async function fixture() {
  const database = openDatabase(':memory:')
  const packs = new PackRepository(database)
  const rooms = new RoomRepository(database)
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
  const engine = new GameEngine(database, rooms, 'https://trivia.example')
  const app = Fastify()
  registerSocketServer(app, rooms, engine, 'https://trivia.example')
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  cleanup.push(async () => {
    engine.dispose()
    await app.close()
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
  return { ...created, engine, rooms, client, clueId: saved.categories[0]!.clues[0]!.id }
}

type Ack = { ok: boolean; error?: string; data?: { phase: string; stateVersion: number; receivedAt?: string } }
const emit = (socket: Socket, event: string, payload: unknown): Promise<Ack> =>
  socket.timeout(2000).emitWithAck(event, payload) as Promise<Ack>

describe('socket persistence acknowledgements', () => {
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
