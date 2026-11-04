import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { registerPackRoutes } from './packs.js'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
})
describe('pack deletion', () => {
  it('persists independent playback settings and rejects invalid settings before replacing a pack', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const pack = await packs.create({ title: 'Playback' })
    const app = Fastify()
    await registerPackRoutes(app, packs)
    cleanups.push(async () => { await app.close(); database.close() })
    const config = {
      correctPrice: 0, min: 0, max: 100,
      mediaPlayback: { delaySeconds: 2, playCount: 3 },
      revealMediaPlayback: { delaySeconds: 0, playCount: 1 },
    }
    const input = { title: 'Playback', categories: [{ title: 'Prices', clues: [
      { type: 'price_slider', boardValue: 100, prompt: 'Price?', config },
    ] }] }
    expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: input })).statusCode).toBe(200)
    expect((await packs.get(pack.id))?.categories[0]?.clues[0]?.config).toEqual(config)
    for (const key of ['mediaPlayback', 'revealMediaPlayback']) {
      for (const invalid of [null, [], { delaySeconds: -1, playCount: 1 }, { delaySeconds: 301, playCount: 1 },
        { delaySeconds: 0.5, playCount: 1 }, { delaySeconds: '2', playCount: 1 },
        { delaySeconds: 0, playCount: -1 }, { delaySeconds: 0, playCount: 1.5 },
        { delaySeconds: 0, playCount: 101 }, { delaySeconds: 0 }]) {
        const bad = structuredClone(input)
        Object.assign(bad.categories[0]!.clues[0]!.config, { [key]: invalid })
        expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: bad })).statusCode).toBe(400)
      }
    }
    expect((await packs.get(pack.id))?.categories[0]?.clues[0]?.config).toEqual(config)
  })
  it('permanently deletes an unused pack and its clues', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const created = (await packs.create({ title: 'Disposable' })) as {
      id: string
    }
    await packs.replace(created.id, {
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
    expect((await packs.get(created.id))).toBeUndefined()
    expect(database.prepare('SELECT COUNT(*) AS count FROM categories').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM clues').get()).toEqual({ count: 0 })
  })
  it('ends and deletes live rooms with the pack', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const rooms = new RoomRepository(database)
    const created = (await packs.create({ title: 'Played pack' })) as {
      id: string
    }
    await packs.replace(created.id, {
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
    await rooms.create(created.id, {
      timerSeconds: 30,
      speedBonusMax: 0,
      priceRankPercentages: [1],
      uniqueNicknames: true,
    }, 4)
    const app = Fastify()
    await registerPackRoutes(app, packs)
    cleanups.push(async () => {
      await app.close()
      database.close()
    })
    const response = await app.inject({ method: 'DELETE', url: `/api/packs/${created.id}` })
    expect(response.statusCode).toBe(204)
    expect((await packs.get(created.id))).toBeUndefined()
    expect(database.prepare('SELECT COUNT(*) AS count FROM rooms').get()).toEqual({ count: 0 })
  })
  it('deletes completed game history with the pack', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const rooms = new RoomRepository(database)
    const created = (await packs.create({ title: 'Played pack' })) as {
      id: string
    }
    await packs.replace(created.id, {
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
    const room = (await rooms.create(created.id, {
      timerSeconds: 30,
      speedBonusMax: 0,
      priceRankPercentages: [1],
      uniqueNicknames: true,
    }, 4))
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
    expect((await packs.get(created.id))).toBeUndefined()
    expect(database.prepare('SELECT COUNT(*) AS count FROM rooms').get()).toEqual({ count: 0 })
  })
})
