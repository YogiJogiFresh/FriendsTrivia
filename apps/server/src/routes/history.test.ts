import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database.js'
import { registerHistoryRoutes } from './history.js'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
})
describe('history deletion', () => {
  it('orders new ISO receipts alongside existing SQLite timestamps chronologically', async () => {
    const database = openDatabase(':memory:')
    const app = Fastify()
    await registerHistoryRoutes(app, database)
    cleanups.push(async () => { await app.close(); database.close() })
    database.exec(`
      INSERT INTO packs(id, title) VALUES ('pack', 'Party');
      INSERT INTO categories(id, pack_id, title, position) VALUES ('category', 'pack', 'Music', 0);
      INSERT INTO clues(id, category_id, type, board_value, position, prompt, config_json)
        VALUES ('clue', 'category', 'price_slider', 100, 0, 'Price?', '{}');
      INSERT INTO rooms(id, code, pack_id, host_token_hash, status, settings_json, state_json)
        VALUES ('room', 'DONE', 'pack', 'hash', 'finished', '{}', '{}');
      INSERT INTO players(id, room_id, nickname, reconnect_token_hash)
        VALUES ('early', 'room', 'Alex', 'hash'), ('late', 'room', 'Sam', 'hash');
      INSERT INTO submissions(id, room_id, player_id, clue_id, answer_json, received_at, elapsed_ms)
        VALUES ('early', 'room', 'early', 'clue', '50', '2026-01-01T12:00:00.000Z', 1000),
               ('late', 'room', 'late', 'clue', '60', '2026-01-01 13:00:00', 2000);
    `)
    const result = await app.inject('/api/history/room')
    expect(result.json().submissions.map((submission: { playerId: string }) => submission.playerId)).toEqual(['early', 'late'])
    const csv = await app.inject('/api/history/room/export.csv')
    expect(csv.body.indexOf('"Alex"')).toBeLessThan(csv.body.indexOf('"Sam"'))
  })
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
    const insertRoom = database.prepare(`INSERT INTO rooms
       (id, code, pack_id, host_token_hash, status, settings_json, state_json)
       VALUES (?, ?, 'pack', 'hash', ?, '{}', '{"phase":"LOBBY","usedClueIds":[]}')`)
    insertRoom.run('finished', 'DONE', 'finished')
    insertRoom.run('abandoned', 'LEFT', 'abandoned')
    insertRoom.run('active', 'LIVE', 'active')
    database
      .prepare(`INSERT INTO players
         (id, room_id, nickname, reconnect_token_hash)
         VALUES ('player', 'finished', 'Alex', 'hash')`)
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
