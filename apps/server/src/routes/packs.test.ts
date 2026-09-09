import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../database.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { registerPackRoutes } from './packs.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('pack deletion', () => {
  it('permanently deletes an unused pack and its clues', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const created = packs.create({ title: 'Disposable' }) as { id: string }
    packs.replace(created.id, {
      title: 'Disposable',
      categories: [
        {
          title: 'Prices',
          clues: [
            {
              type: 'price_slider',
              boardValue: 100,
              prompt: 'How much?',
              config: { correctPrice: 50, min: 0, max: 100 },
            },
          ],
        },
      ],
    })
    const app = Fastify()
    await registerPackRoutes(app, packs)
    cleanups.push(async () => {
      await app.close()
      database.close()
    })

    const response = await app.inject({ method: 'DELETE', url: `/api/packs/${created.id}` })

    expect(response.statusCode).toBe(204)
    expect(packs.get(created.id)).toBeUndefined()
    expect(database.prepare('SELECT COUNT(*) AS count FROM categories').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM clues').get()).toEqual({ count: 0 })
  })

  it('ends and deletes live rooms with the pack', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const rooms = new RoomRepository(database)
    const created = packs.create({ title: 'Played pack' }) as { id: string }
    packs.replace(created.id, {
      title: 'Played pack',
      status: 'ready',
      categories: [
        {
          title: 'Prices',
          clues: [
            {
              type: 'price_slider',
              boardValue: 100,
              prompt: 'How much?',
              config: { correctPrice: 50, min: 0, max: 100 },
            },
          ],
        },
      ],
    })
    rooms.create(
      created.id,
      {
        timerSeconds: 30,
        speedBonusMax: 0,
        priceRankPercentages: [1],
        uniqueNicknames: true,
      },
      4,
    )
    const app = Fastify()
    await registerPackRoutes(app, packs)
    cleanups.push(async () => {
      await app.close()
      database.close()
    })

    const response = await app.inject({ method: 'DELETE', url: `/api/packs/${created.id}` })

    expect(response.statusCode).toBe(204)
    expect(packs.get(created.id)).toBeUndefined()
    expect(database.prepare('SELECT COUNT(*) AS count FROM rooms').get()).toEqual({ count: 0 })
  })

  it('deletes completed game history with the pack', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const rooms = new RoomRepository(database)
    const created = packs.create({ title: 'Played pack' }) as { id: string }
    packs.replace(created.id, {
      title: 'Played pack',
      status: 'ready',
      categories: [
        {
          title: 'Prices',
          clues: [
            {
              type: 'price_slider',
              boardValue: 100,
              prompt: 'How much?',
              config: { correctPrice: 50, min: 0, max: 100 },
            },
          ],
        },
      ],
    })
    const room = rooms.create(
      created.id,
      {
        timerSeconds: 30,
        speedBonusMax: 0,
        priceRankPercentages: [1],
        uniqueNicknames: true,
      },
      4,
    )
    database
      .prepare("UPDATE rooms SET status = 'finished', completed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(room.room.id)
    const app = Fastify()
    await registerPackRoutes(app, packs)
    cleanups.push(async () => {
      await app.close()
      database.close()
    })

    const response = await app.inject({ method: 'DELETE', url: `/api/packs/${created.id}` })

    expect(response.statusCode).toBe(204)
    expect(packs.get(created.id)).toBeUndefined()
    expect(database.prepare('SELECT COUNT(*) AS count FROM rooms').get()).toEqual({ count: 0 })
  })
})
