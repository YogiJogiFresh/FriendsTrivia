import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateDatabase, migrations, openDatabase } from './database.js'
import type { RoomCommit } from './domain.js'
import { createSqliteStore } from './sqliteStore.js'
import { PackRepository } from './repositories/packs.js'
import { RoomRepository } from './repositories/rooms.js'
import { GameEngine } from './game/engine.js'

const databases: Database.Database[] = []
afterEach(() => { for (const database of databases.splice(0)) if (database.open) database.close() })
async function fixture() {
  const database = openDatabase(':memory:')
  databases.push(database)
  const store = createSqliteStore(database)
  const packs = new PackRepository(store)
  const rooms = new RoomRepository(store)
  const pack = await packs.create({ title: 'Domain' })
  const saved = await packs.replace(pack.id, { title: 'Domain', status: 'ready', categories: [{
    title: 'Prices', clues: [{ type: 'price_slider', boardValue: 100, prompt: 'Price?',
      config: { correctPrice: 50, min: 0, max: 100 } }],
  }] })
  const created = await rooms.create(pack.id, {
    timerSeconds: 30, speedBonusMax: 100, priceRankPercentages: [1], uniqueNicknames: true,
  }, 4)
  const player = (await rooms.join(created.room, 'Alex')).player
  const engine = new GameEngine(store, rooms, 'http://localhost:3000')
  return { database, store, rooms, engine, room: created.room, player, clueId: saved!.categories[0]!.clues[0]!.id }
}
describe('typed domain SQLite store', () => {
  it('migrates existing version-eight data in place and is idempotent', () => {
    const database = new Database(':memory:')
    databases.push(database)
    for (const migration of migrations.slice(0, 8)) database.exec(migration)
    database.pragma('user_version = 8')
    database.prepare("INSERT INTO packs (id,title) VALUES ('existing','Keep this pack')").run()
    migrateDatabase(database)
    migrateDatabase(database)
    expect(database.prepare("SELECT title FROM packs WHERE id = 'existing'").get()).toEqual({ title: 'Keep this pack' })
    expect(database.pragma('user_version', { simple: true })).toBe(migrations.length)
  })
  it('separates room revision from public stateVersion and replays the same atomic receipt once', async () => {
    const game = await fixture()
    const loaded = await game.store.rooms.load(game.room.ref)
    const command: RoomCommit = {
      ref: loaded.ref, expectedRevision: loaded.revision, operationId: 'adjust-once',
      at: new Date().toISOString(),
      change: { kind: 'adjustment', award: { playerId: game.player.id, delta: 10,
        source: 'host_adjustment', reason: 'Correction', actor: 'host' } },
    }
    const first = await game.store.rooms.commit(command)
    const second = await game.store.rooms.commit(command)
    expect(first.room.stateVersion).toBe(loaded.room.stateVersion)
    expect(second.activeScores[0]?.score).toBe(10)
    expect(first.revision).not.toBe(loaded.revision)
    await expect(game.store.rooms.commit({ ...command, change: { ...command.change,
      kind: 'adjustment', award: { playerId: game.player.id, delta: 20, source: 'host_adjustment', reason: 'Different', actor: 'host' } } })).rejects.toThrow('Operation ID reused')
    await expect(game.store.rooms.load({ ...loaded.ref, generation: 'old-generation' })).rejects.toThrow('Room not found')
    game.engine.dispose()
  })
  it('rejects stale prepared results and only recovers uncommitted result chunks', async () => {
    const game = await fixture()
    const loaded = await game.store.rooms.load(game.room.ref)
    await game.store.rooms.prepareResult(loaded.ref, loaded.revision, 'abandoned-build', 0, { entries: [], awards: [] })
    await game.engine.adjustScore(game.room, game.player.id, 10, 'Correction')
    await expect(game.store.rooms.prepareResult(loaded.ref, loaded.revision, 'stale-build', 0, { entries: [], awards: [] })).rejects.toThrow('Room changed')
    await game.store.recover()
    expect(game.database.prepare('SELECT COUNT(*) AS count FROM result_chunks').get()).toEqual({ count: 0 })
    game.engine.dispose()
  })
  it('persists upload/delete recovery tickets without a local quota or duplicate deletion ownership', async () => {
    const game = await fixture()
    const reservation = await game.store.media.reserveUpload('upload', ['songs/local.mp3'])
    const grown = await game.store.media.growReservation(reservation, 5_000_000_001)
    const asset = await game.store.media.commitUploaded(grown, {
      relativePath: 'songs/local.mp3', originalName: 'local.mp3', mimeType: 'audio/mpeg', sizeBytes: grown.reservedBytes,
    }, grown.reservedBytes)
    const deletion = (await game.store.media.beginDelete(asset.id, 'delete-one'))!
    expect(await game.store.media.beginDelete(asset.id, 'delete-two')).toEqual(deletion)
    await expect(game.store.media.finishDelete(deletion, false)).rejects.toThrow('still exists')
    expect((await game.store.media.pendingCleanup()).items).toHaveLength(1)
    await game.store.media.finishDelete(deletion, true)
    expect(await game.store.media.get(asset.id)).toBeUndefined()
    expect((await game.store.media.pendingCleanup()).items).toHaveLength(0)
    game.engine.dispose()
  })
  it('pauses every interrupted room even when recovery mutates a full page', async () => {
    const game = await fixture()
    const packId = game.room.packId
    for (let index = 0; index < 102; index++) {
      const created = await game.rooms.create(packId, game.room.settings, 6)
      await game.rooms.saveState(created.room.id, { ...created.room.state, phase: 'BOARD' }, 'active', created.room.stateVersion)
    }
    expect(await game.rooms.pauseActiveRooms()).toBe(102)
    expect((await game.store.rooms.interrupted({ limit: 100 })).items).toHaveLength(0)
    await game.rooms.drain()
    await expect(game.rooms.runRoom(game.room.id, async () => {})).rejects.toThrow('shutting down')
    game.engine.dispose()
  })
})
