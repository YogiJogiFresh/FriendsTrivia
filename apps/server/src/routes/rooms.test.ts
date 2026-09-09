import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../database.js'
import { GameEngine } from '../game/engine.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { registerRoomRoutes } from './rooms.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('host room recovery', () => {
  it('requires the host token and can end an active room', async () => {
    const database = openDatabase(':memory:')
    const rooms = new RoomRepository(database)
    const packs = new PackRepository(database)
    const engine = new GameEngine(database, rooms, 'http://192.168.1.10:3000')
    const app = Fastify()
    await registerRoomRoutes(app, rooms, engine, 4, () => 'http://192.168.1.10:3000')
    cleanups.push(async () => {
      await app.close()
      database.close()
    })

    const pack = packs.create({ title: 'Party' }) as { id: string }
    packs.replace(pack.id, {
      title: 'Party',
      status: 'ready',
      categories: [
        {
          title: 'Prices',
          clues: [
            {
              type: 'price_slider',
              boardValue: 200,
              prompt: 'How much?',
              config: { correctPrice: 100, min: 0, max: 200, step: 1 },
            },
          ],
        },
      ],
    })
    const created = rooms.create(
      pack.id,
      {
        timerSeconds: 30,
        speedBonusMax: 100,
        priceRankPercentages: [1],
        uniqueNicknames: true,
      },
      4,
    )
    rooms.join(created.room, 'Alex')
    engine.startGame(created.room)

    const unauthorized = await app.inject({
      method: 'GET',
      url: `/api/rooms/${created.room.code}/host-session`,
    })
    expect(unauthorized.statusCode).toBe(401)

    const session = await app.inject({
      method: 'GET',
      url: `/api/rooms/${created.room.code}/host-session`,
      headers: { authorization: `Bearer ${created.hostToken}` },
    })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ code: created.room.code, status: 'active', phase: 'BOARD' })

    const ended = await app.inject({
      method: 'POST',
      url: `/api/rooms/${created.room.code}/end`,
      headers: { authorization: `Bearer ${created.hostToken}` },
    })
    expect(ended.statusCode).toBe(200)
    expect(ended.json()).toMatchObject({ status: 'abandoned', phase: 'FINISHED' })
  })
})
