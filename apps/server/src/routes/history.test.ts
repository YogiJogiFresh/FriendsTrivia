import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../database.js'
import { registerHistoryRoutes } from './history.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('history deletion', () => {
  it('deletes completed history without affecting active rooms', async () => {
    const database = openDatabase(':memory:')
    const app = Fastify()
    await registerHistoryRoutes(app, database)
    cleanups.push(async () => {
      await app.close()
      database.close()
    })

    database
      .prepare("INSERT INTO packs (id, title, status) VALUES ('pack', 'Party', 'ready')")
      .run()
    const insertRoom = database.prepare(
      `INSERT INTO rooms
       (id, code, pack_id, host_token_hash, status, settings_json, state_json)
       VALUES (?, ?, 'pack', 'hash', ?, '{}', '{"phase":"LOBBY","usedClueIds":[]}')`,
    )
    insertRoom.run('finished', 'DONE', 'finished')
    insertRoom.run('abandoned', 'LEFT', 'abandoned')
    insertRoom.run('active', 'LIVE', 'active')
    database
      .prepare(
        `INSERT INTO players
         (id, room_id, nickname, reconnect_token_hash)
         VALUES ('player', 'finished', 'Alex', 'hash')`,
      )
      .run()

    const activeResponse = await app.inject({
      method: 'DELETE',
      url: '/api/history/active',
    })
    expect(activeResponse.statusCode).toBe(409)

    const completedResponse = await app.inject({
      method: 'DELETE',
      url: '/api/history/finished',
    })
    expect(completedResponse.statusCode).toBe(204)
    expect(database.prepare("SELECT id FROM players WHERE id = 'player'").get()).toBeUndefined()

    const clearResponse = await app.inject({ method: 'DELETE', url: '/api/history' })
    expect(clearResponse.json()).toEqual({ deletedCount: 1 })
    expect(database.prepare("SELECT id FROM rooms WHERE id = 'active'").get()).toBeDefined()
  })
})
