import { afterEach, describe, expect, it, vi } from 'vitest'
import { CosmosClient, CosmosDiagnostics, FeedResponse } from '@azure/cosmos'
import { createCosmosStore, openCosmosStore } from './cosmos.js'
import { FakeCosmos } from './cosmosFake.testSupport.js'
import { CosmosFailure, document, LIBRARY_PK, MAX_BATCH_BYTES, retry, SdkCosmosAccess, validateBatch } from './cosmosIo.js'
import { SONG_QUOTA_BYTES } from './cosmosMedia.js'
import { CosmosRooms, type RoomDoc, roomItemId } from './cosmosRooms.js'
import { createId, createToken } from '../ids.js'
import { type DeploymentConfig, cloudConfig, config } from '../config.js'
import type { DomainStore, MediaAsset, RoomCommit } from '../domain.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { GameEngine } from '../game/engine.js'
import type { GameSettings } from '../game/types.js'
import { MediaRepository } from '../repositories/media.js'
import { recoverMediaOperations } from '../storage/operations.js'
import type { MediaStorage } from '../storage/media.js'
import { OwnedTestAccess, validateCosmosTestTarget } from './cosmosTestTarget.js'

const engines: GameEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.restoreAllMocks() })
const settings: GameSettings = { timerSeconds: 30, speedBonusMax: 100, priceRankPercentages: [1, 0.5], uniqueNicknames: true }
async function fixture(roomCode?: (length: number) => string) {
  const games = new FakeCosmos(), library = new FakeCosmos(), store = await createCosmosStore(games, library, roomCode)
  const packs = new PackRepository(store), rooms = new RoomRepository(store)
  const pack = await packs.create({ title: 'Cloud price' })
  const saved = (await packs.replace(pack.id, { title: pack.title, status: 'ready', categories: [{
    title: 'Prices', clues: [{ type: 'price_slider', boardValue: 100, prompt: 'Original?',
      config: { correctPrice: 50, min: 0, max: 100 } }],
  }] }))!
  const created = await rooms.create(pack.id, settings, 4)
  const engine = new GameEngine(store, rooms, 'http://localhost:3000')
  engines.push(engine)
  return { games, library, store, packs, rooms, pack: saved, room: created.room, engine, clueId: saved.categories[0]!.clues[0]!.id }
}
async function upload(store: DomainStore, key: string, size: number, owner?: { kind: 'operation'; id: string }): Promise<MediaAsset> {
  const reservation = await store.media.reserveUpload(`upload-${key}`, [key])
  const grown = await store.media.growReservation(reservation, size)
  return store.media.commitUploaded(grown, { relativePath: key, originalName: 'song.mp3', mimeType: 'audio/mpeg', sizeBytes: size }, size, owner)
}
function adjustment(ref: RoomCommit['ref'], revision: string, playerId: string, operationId = 'adjust-once', delta = 10): RoomCommit {
  return { ref, expectedRevision: revision, operationId, at: new Date().toISOString(),
    change: { kind: 'adjustment', award: { playerId, delta, source: 'host_adjustment', reason: 'Correction', actor: 'host' } } }
}
describe('Cosmos adapter — OFFLINE SDK-seam tests, NOT live Cosmos conformance', () => {
  it('recovers the original team, score, answer and wager at capacity without changing the game window', async () => {
    const game = await fixture()
    const created = await game.rooms.create(game.pack.id, { ...settings, teams: ['Blue'] }, 4)
    const joined = await game.rooms.join(created.room, 'Alex', 'Blue')
    for (let index = 1; index < 50; index++) await game.rooms.join(created.room, `Player ${index}`, 'Blue')
    await game.engine.adjustScore(created.room, joined.player.id, 123, 'Existing score')
    let room = await game.engine.startGame(created.room)
    room = await game.engine.selectClue(room, game.clueId)
    await game.engine.submitAnswer(room, joined.player.id, 50)
    const loaded = await game.store.rooms.load(room.ref), attempt = { clueId: game.clueId, attempt: room.state.attempt! }
    await game.store.rooms.commit({ ref: room.ref, expectedRevision: loaded.revision, operationId: createId(), at: new Date().toISOString(),
      change: { kind: 'wager', attempt, generation: room.state.wagerGeneration ?? 0, wager: { playerId: joined.player.id, amount: 10 } } })
    await game.rooms.setJoiningLocked(room.id, true)
    await game.rooms.setConnected(joined.player.id, false)
    const before = await game.store.rooms.load(room.ref), answer = await game.store.rooms.submissionForPlayer(room.ref, attempt, joined.player.id)
    const token = createToken()
    game.games.fail = { code: 503 }
    await expect(game.rooms.recoverSeat(before.room, joined.player.id, token)).rejects.toThrow()
    expect((await game.store.rooms.loadPlayer(room.ref, joined.player.id))?.reconnectTokenHash).toBe(joined.player.reconnectTokenHash)
    await game.rooms.recoverSeat(before.room, joined.player.id, token)
    const after = await game.store.rooms.load(room.ref)
    expect(after.activeScores).toHaveLength(50)
    expect(after.activeScores[0]).toMatchObject({ playerId: joined.player.id, nickname: 'Alex', teamName: 'Blue', score: 123, connected: true })
    expect(after.room.state).toEqual(before.room.state)
    expect(after.room.joiningLocked).toBe(true)
    expect(await game.store.rooms.submissionForPlayer(room.ref, attempt, joined.player.id)).toEqual(answer)
    expect(await game.store.rooms.wagers(room.ref, attempt)).toEqual([{ playerId: joined.player.id, amount: 10 }])
    expect(await game.rooms.reconnect(room, joined.player.id, joined.reconnectToken)).toBeUndefined()
    await expect(game.engine.submitAnswer((await game.rooms.getById(room.id))!, joined.player.id, 50)).rejects.toThrow('already')
    await expect(game.rooms.recoverSeat(room, joined.player.id, createToken())).rejects.toMatchObject({ code: 'seat_connected' })
    await game.rooms.kickPlayer(room.id, joined.player.id)
    await expect(game.rooms.recoverSeat(room, joined.player.id, createToken())).rejects.toMatchObject({ code: 'invalid_identity' })
  })

  it('shares frozen queries, protects cached values and revalidates deleted or reused generations', async () => {
    const game = await fixture(() => 'CACHE')
    const queries = vi.spyOn(game.games, 'query'), reads = vi.spyOn(game.games, 'read')
    const board = await game.store.rooms.board(game.room.ref)
    board[0]!.categoryTitle = 'Changed by caller'
    const clue = (await game.store.rooms.clue(game.room.ref, game.clueId))!
    clue.config.correctPrice = 999
    expect(await game.store.rooms.finalClueId(game.room.ref)).toBeUndefined()
    expect((await game.store.rooms.board(game.room.ref))[0]?.categoryTitle).toBe('Prices')
    expect((await game.store.rooms.clue(game.room.ref, game.clueId))?.config.correctPrice).toBe(50)
    expect(queries.mock.calls.filter(([query]) => query.filters.some((filter) => filter.value === 'frozenClue'))).toHaveLength(1)
    await game.rooms.join(game.room, 'Alex')
    expect(queries).toHaveBeenCalledTimes(1)
    reads.mockClear()
    await game.rooms.getByCode('cache')
    expect(reads.mock.calls).toHaveLength(3)
    expect(reads.mock.calls.some(([pk]) => pk.startsWith('id:'))).toBe(false)
    await game.engine.endSession(game.room)
    expect(await game.store.history.removeCompleted(game.room.id)).toBe('deleted')
    await expect(game.store.rooms.board(game.room.ref)).rejects.toMatchObject({ code: 'not_found' })
    const created = await game.rooms.create(game.pack.id, settings, 4)
    expect(created.room.code).toBe(game.room.code)
    expect(created.room.ref.generation).not.toBe(game.room.ref.generation)
    expect((await game.store.rooms.board(created.room.ref))[0]?.categoryTitle).toBe('Prices')
    await expect(game.store.rooms.clue(game.room.ref, game.clueId)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('coalesces cache misses, retries failed fills and clears cache on close', async () => {
    const game = await fixture(), query = game.games.query.bind(game.games)
    const queries = vi.spyOn(game.games, 'query').mockRejectedValueOnce(new Error('Read unavailable'))
    await expect(game.store.rooms.board(game.room.ref)).rejects.toThrow('Read unavailable')
    queries.mockImplementation(query)
    await Promise.all([game.store.rooms.board(game.room.ref), game.store.rooms.clue(game.room.ref, game.clueId), game.store.rooms.finalClueId(game.room.ref)])
    expect(queries).toHaveBeenCalledTimes(2)
    await game.store.close()
    await game.store.rooms.board(game.room.ref)
    expect(queries).toHaveBeenCalledTimes(3)
  })

  it('evicts old generations and bypasses oversized frozen metadata instead of retaining it', async () => {
    const game = await fixture()
    const board = await game.store.rooms.board(game.room.ref)
    for (let index = 0; index < 32; index++) {
      const created = await game.rooms.create(game.pack.id, settings, 4)
      await game.store.rooms.board(created.room.ref)
    }
    const queries = vi.spyOn(game.games, 'query')
    await game.store.rooms.board(game.room.ref)
    expect(queries).toHaveBeenCalledTimes(1)
    const adapter = game.store.rooms as CosmosRooms
    adapter.close()
    const query = game.games.query.bind(game.games)
    queries.mockImplementationOnce(async (...args) => {
      const page = await query(...args)
      return { ...page, items: page.items.map((doc) => ({ ...doc, padding: 'x'.repeat(16 * 1024 * 1024) })) }
    })
    expect(await adapter.board(game.room.ref)).toEqual(board)
    const count = queries.mock.calls.length
    await adapter.clue(game.room.ref, game.clueId)
    expect(queries).toHaveBeenCalledTimes(count)
  })
  it('supports packs, settings, creation, join/reconnect and frozen rooms independently of edited library', async () => {
    const game = await fixture()
    expect(game.store.mode).toBe('cloud')
    expect((await game.store.packs.list()).items).toHaveLength(1)
    await game.store.settings.setGifKey('giphy', 'offline-test-key')
    expect(await game.store.settings.gifKey('giphy')).toBe('offline-test-key')
    const joined = await game.rooms.join(game.room, 'Alex')
    expect(await game.store.rooms.findPlayer(joined.player.id)).toEqual(joined.player)
    await game.rooms.setConnected(joined.player.id, false)
    expect((await game.rooms.reconnect(game.room, joined.player.id, joined.reconnectToken))?.connected).toBe(true)
    expect(await game.rooms.reconnect(game.room, joined.player.id, 'invalid-token')).toBeUndefined()
    await expect(game.rooms.join(game.room, 'alex')).rejects.toMatchObject({ code: 'nickname_taken' })
    const old = game.pack.categories[0]!.clues[0]!
    await game.packs.replace(game.pack.id, { ...game.pack, title: 'Edited', categories: [{
      ...game.pack.categories[0]!, clues: [{ ...old, prompt: 'Changed?', config: { correctPrice: 80, min: 0, max: 100 } }],
    }] })
    expect((await game.store.rooms.clue(game.room.ref, old.id))?.prompt).toBe('Original?')
    expect((await game.store.rooms.clue(game.room.ref, old.id))?.config.correctPrice).toBe(50)
    expect((await game.store.rooms.board(game.room.ref))[0]?.categoryTitle).toBe('Prices')
    expect(await game.store.rooms.resolveCode(game.room.code.toLowerCase())).toEqual(game.room.ref)
    await expect(game.store.rooms.load({ ...game.room.ref, generation: 'old' })).rejects.toMatchObject({ code: 'not_found' })
    expect(await game.store.history.removeCompleted(game.room.id)).toBe('active')
    await game.engine.endSession(game.room)
    expect((await game.store.history.list()).items[0]?.packTitle).toBe('Cloud price')
    expect((await game.store.history.players(game.room.id)).items[0]?.nickname).toBe('Alex')
    expect((await game.store.history.header(game.room.id))?.status).toBe('abandoned')
    expect(await game.store.history.removeAllCompleted()).toBe(1)
    expect(await game.store.rooms.resolveId(game.room.id)).toBeUndefined()
    expect((await game.store.packs.get(game.pack.id))?.title).toBe('Edited')
  })
  it('commits 50-player price scoring in bounded result pages, summary CAS and receipt, not per-player score writes', async () => {
    const game = await fixture()
    const players = []
    for (let index = 0; index < 50; index++) players.push((await game.rooms.join(game.room, `Player ${index}`)).player)
    const reads = vi.spyOn(game.games, 'read'), queries = vi.spyOn(game.games, 'query')
    expect(await game.store.rooms.listPlayers(game.room.ref)).toEqual(players)
    expect(reads).toHaveBeenCalledTimes(2)
    expect(queries).toHaveBeenCalledTimes(1)
    expect(queries.mock.calls[0]?.[0]).toMatchObject({ pk: game.room.code, filters: [
      { field: 'generation', value: game.room.ref.generation }, { field: 'kind', value: 'player' },
      { field: 'player.id', op: 'IN', value: players.map(({ id }) => id) },
    ] })
    reads.mockRestore(); queries.mockRestore()
    await expect(game.rooms.join(game.room, 'Player 51')).rejects.toThrow('full')
    game.room = await game.engine.startGame(game.room)
    game.room = await game.engine.selectClue(game.room, game.clueId)
    for (const player of players) await game.engine.submitAnswer(game.room, player.id, 50)
    const before = game.games.batches.length
    game.room = await game.engine.closeAnswers(game.room)
    const writes = game.games.batches.slice(before).filter((batch) => batch.writes.some((write) => write.type !== 'delete' && write.doc.kind === 'result'))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.writes).toHaveLength(4)
    expect(writes[0]!.bytes).toBeLessThan(MAX_BATCH_BYTES)
    const loaded = await game.store.rooms.load(game.room.ref)
    expect(loaded.activeScores).toHaveLength(50)
    expect(loaded.activeScores.every(({ score }) => score === 100)).toBe(true)
    const attempt = { clueId: game.clueId, attempt: loaded.room.state.attempt! }
    const first = await game.store.rooms.results(game.room.ref, attempt, { limit: 23 })
    const second = await game.store.rooms.results(game.room.ref, attempt, { limit: 30, cursor: first.cursor! })
    expect(first.items).toHaveLength(23)
    expect(second.items).toHaveLength(27)
    expect(second.cursor).toBeUndefined()
    expect((await game.store.history.submissions(game.room.id, { limit: 17 })).items).toHaveLength(17)
    expect((await game.store.history.exportRows(game.room.id, { limit: 2 })).items[0]).toMatchObject({ category: 'Prices', points_awarded: 100, answer_json: '50' })
    expect((await game.store.history.players(game.room.id)).items.every(({ score }) => score === 100)).toBe(true)
  })
  it('recovers uncertain successful commit by immutable receipt and rejects stale CAS and payload reuse', async () => {
    const game = await fixture(), joined = await game.rooms.join(game.room, 'Alex'), loaded = await game.store.rooms.load(game.room.ref)
    const command = adjustment(loaded.ref, loaded.revision, joined.player.id)
    game.games.fail = { code: 503, after: true }
    const first = await game.store.rooms.commit(command)
    expect(first.activeScores[0]?.score).toBe(10)
    expect((await game.store.rooms.commit(command)).activeScores[0]?.score).toBe(10)
    await expect(game.store.rooms.commit(adjustment(loaded.ref, loaded.revision, joined.player.id, 'other'))).rejects.toMatchObject({ code: 'conflict' })
    await expect(game.store.rooms.commit(adjustment(loaded.ref, first.revision, joined.player.id, 'adjust-once', 20))).rejects.toThrow('Operation ID reused')
    const current = await game.store.rooms.load(game.room.ref)
    game.games.fail = { code: 412 }
    await expect(game.store.rooms.commit(adjustment(current.ref, current.revision, joined.player.id, 'etag-fail'))).rejects.toMatchObject({ code: 'conflict' })
    expect((await game.store.rooms.load(game.room.ref)).activeScores[0]?.score).toBe(10)
    game.games.fail = { code: 429 }
    await game.store.rooms.commit(adjustment(current.ref, current.revision, joined.player.id, 'throttle'))
    expect((await game.store.rooms.load(game.room.ref)).activeScores[0]?.score).toBe(20)
  })
  it('retains immutable attempt audit while resets preserve manual scores and final wagers and go-back clears wagers', async () => {
    const game = await fixture(), joined = await game.rooms.join(game.room, 'Alex')
    await game.engine.adjustScore(game.room, joined.player.id, 20, 'Manual')
    game.room = await game.engine.startGame(game.room)
    game.room = await game.engine.selectClue(game.room, game.clueId)
    await game.engine.submitAnswer(game.room, joined.player.id, 50)
    await expect(game.engine.submitAnswer(game.room, joined.player.id, 50)).rejects.toThrow('already')
    game.room = await game.engine.closeAnswers(game.room)
    const prior = await game.store.rooms.load(game.room.ref), oldAttempt = { clueId: game.clueId, attempt: prior.room.state.attempt! }
    expect(prior.activeScores[0]?.score).toBe(120)
    game.room = await game.engine.resetClue(game.room)
    expect((await game.rooms.scores(game.room.id))[0]?.score).toBe(20)
    expect((await game.store.rooms.results(game.room.ref, oldAttempt)).items).toEqual([])
    expect((await game.store.rooms.submissions(game.room.ref, oldAttempt)).items).toEqual([])
    expect([...game.games.documents.values()].filter(({ kind }) => kind === 'submission')).toHaveLength(1)
    expect((await game.store.history.submissions(game.room.id)).items).toEqual([])
    expect((await game.store.history.players(game.room.id)).items[0]?.score).toBe(20)
    let current = await game.store.rooms.load(game.room.ref)
    const attempt = { clueId: game.clueId, attempt: current.room.state.attempt! }
    await game.store.rooms.commit({ ref: current.ref, expectedRevision: current.revision, operationId: 'wager', at: new Date().toISOString(),
      change: { kind: 'wager', attempt, generation: 0, wager: { playerId: joined.player.id, amount: 10 } } })
    current = await game.store.rooms.load(game.room.ref)
    await expect(game.store.rooms.commit({ ref: current.ref, expectedRevision: current.revision, operationId: 'duplicate-wager', at: new Date().toISOString(),
      change: { kind: 'wager', attempt, generation: 0, wager: { playerId: joined.player.id, amount: 10 } } })).rejects.toMatchObject({ code: 'duplicate_wager' })
    game.room = await game.engine.resetClue(game.room)
    expect(await game.store.rooms.wagers(game.room.ref, { clueId: game.clueId, attempt: 99 })).toEqual([{ playerId: joined.player.id, amount: 10 }])
    await game.engine.goBack(game.room)
    expect(await game.store.rooms.wagers(game.room.ref, attempt)).toEqual([])
  })
  it('does not grow room roster with kicked players and stages churn results invisibly until descriptor commit', async () => {
    const game = await fixture()
    const kept = (await game.rooms.join(game.room, 'Kept')).player
    game.room = await game.engine.startGame(game.room)
    game.room = await game.engine.selectClue(game.room, game.clueId)
    for (let index = 0; index < 105; index++) {
      const player = (await game.rooms.join(game.room, `Churn ${index}`)).player
      await game.engine.submitAnswer(game.room, player.id, 50)
      await game.rooms.kickPlayer(game.room.id, player.id)
    }
    await game.engine.submitAnswer(game.room, kept.id, 50)
    expect((await game.store.rooms.load(game.room.ref)).activeScores).toHaveLength(1)
    const doc = await game.games.read<RoomDoc>(game.room.code, roomItemId(game.room.ref, 'room'))
    expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThan(6000)
    game.room = await game.engine.closeAnswers(game.room)
    const loaded = await game.store.rooms.load(game.room.ref), attempt = { clueId: game.clueId, attempt: loaded.room.state.attempt! }
    const result = await game.store.rooms.results(game.room.ref, attempt, { limit: 100 })
    expect(result.items).toHaveLength(100)
    expect((await game.store.rooms.results(game.room.ref, attempt, { cursor: result.cursor!, limit: 100 })).items).toHaveLength(6)
    await game.engine.resetClue(game.room)
    expect((await game.store.history.players(game.room.id, { limit: 100 })).items.every(({ score }) => score === 0)).toBe(true)
    expect((await game.store.rooms.load(game.room.ref)).activeScores[0]?.score).toBe(0)
    await expect(game.rooms.join(game.room, 'Churn 0')).rejects.toMatchObject({ code: 'nickname_taken' })
  })
  it('recovers interrupted room deletion before code reuse and stale cleanup cannot erase the next generation', async () => {
    const game = await fixture(() => 'CODE')
    await game.engine.endSession(game.room)
    game.games.fail = { code: 503, when: (writes) => writes.some((write) => write.type === 'delete') }
    await expect(game.store.history.removeCompleted(game.room.id)).rejects.toThrow('Cosmos request failed')
    expect(await game.store.rooms.resolveCode('CODE')).toBeUndefined()
    await expect(game.rooms.create(game.pack.id, settings, 4)).rejects.toThrow('allocate')
    await game.store.recover()
    const next = await game.rooms.create(game.pack.id, settings, 4)
    expect(next.room.ref.generation).not.toBe(game.room.ref.generation)
    expect(await game.store.history.removeCompleted(game.room.id)).toBe('not_found')
    await expect(game.store.rooms.commit(adjustment(game.room.ref, 'old', 'old-player'))).rejects.toMatchObject({ code: 'not_found' })
    expect(await game.store.rooms.resolveCode('CODE')).toEqual(next.room.ref)
  })
  it('protects shared/reveal songs through ready pack revisions and frozen rooms, and deleting a pack does not delete songs', async () => {
    const game = await fixture()
    const asset = await upload(game.store, 'songs/shared.mp3', 100)
    const input = { ...game.pack, categories: [{ ...game.pack.categories[0]!, clues: [{
      ...game.pack.categories[0]!.clues[0]!, mediaAssetId: asset.id, revealMediaAssetId: asset.id,
    }] }] }
    const published = (await game.packs.replace(game.pack.id, input))!
    await expect(game.store.media.beginDelete(asset.id, 'blocked-pack')).rejects.toMatchObject({ code: 'media_referenced' })
    const second = await game.rooms.create(game.pack.id, settings, 4)
    await game.packs.replace(game.pack.id, { ...published, categories: [] , status: 'draft' })
    await expect(game.store.media.beginDelete(asset.id, 'blocked-room')).rejects.toMatchObject({ code: 'media_referenced' })
    await game.engine.endSession(second.room)
    await game.store.history.removeCompleted(second.room.id)
    const deletion = (await game.store.media.beginDelete(asset.id, 'delete'))!
    expect(await game.store.media.findByPath(asset.relativePath)).toEqual(asset)
    await expect(game.store.media.claim({ kind: 'pack', id: 'race', revision: '1' }, [asset.id])).rejects.toMatchObject({ code: 'media_referenced' })
    await expect(game.store.media.finishDelete(deletion, false)).rejects.toThrow('still exists')
    await game.store.media.finishDelete(deletion, true)
    await game.store.media.finishDelete(deletion, true)
    const other = await upload(game.store, 'songs/keep.mp3', 100)
    await game.packs.remove(game.pack.id)
    expect(await game.store.media.get(other.id)).toEqual(other)
    expect(await game.store.rooms.resolveId(game.room.id)).toBeUndefined()
  })
  it('CAS-fences claim versus deletion and concurrent quota growth, retaining partial capacity until absence confirmation', async () => {
    const game = await fixture()
    const left = await game.store.media.reserveUpload('left', ['songs/left.mp3'])
    const right = await game.store.media.reserveUpload('right', ['songs/right.mp3'])
    const growth = await Promise.allSettled([
      game.store.media.growReservation(left, SONG_QUOTA_BYTES),
      game.store.media.growReservation(right, SONG_QUOTA_BYTES),
    ])
    expect(growth.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(growth.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    await expect(game.store.media.abortUpload(left, [])).rejects.toThrow('incomplete')
    await game.store.recover()
    const quota = await game.library.read<ReturnType<typeof document> & { reservedBytes: number }>(LIBRARY_PK, 'quota')
    expect(quota?.reservedBytes).toBe(SONG_QUOTA_BYTES)
    await game.store.media.abortUpload(left, left.ownedKeys)
    await game.store.media.abortUpload(right, right.ownedKeys)
    const asset = await upload(game.store, 'songs/race.mp3', 1)
    const race = await Promise.allSettled([
      game.store.media.claim({ kind: 'pack', id: 'owner', revision: '1' }, [asset.id]),
      game.store.media.beginDelete(asset.id, 'racing-delete'),
    ])
    expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect((await game.store.media.pendingCleanup()).items.every(({ kind }) => kind !== 'upload')).toBe(true)
  })
  it('keeps durable operation journals across partial claim release and marks published before releasing unused songs', async () => {
    const game = await fixture(), owner = { kind: 'operation' as const, id: 'import' }
    const asset = await upload(game.store, 'songs/orphan.mp3', 2, owner)
    await game.store.media.releaseClaims(owner)
    expect((await game.store.media.pendingCleanup()).items).toContainEqual({ kind: 'operation', owner, ownedKeys: [asset.relativePath], published: false })
    const ticket = (await game.store.media.beginDelete(asset.id, 'cleanup'))!
    await expect(game.store.media.finishDelete(ticket, false)).rejects.toThrow()
    expect((await game.store.media.pendingCleanup()).items.some(({ kind }) => kind === 'operation')).toBe(true)
    await game.store.media.finishDelete(ticket, true)
    await game.store.media.completeOperation(owner)
    expect((await game.store.media.pendingCleanup()).items).toEqual([])
    const published = { kind: 'operation' as const, id: 'successful-import' }
    const unused = await upload(game.store, 'songs/unused.mp3', 3, published)
    await game.store.media.completeOperation(published)
    expect((await game.store.media.pendingCleanup()).items).toContainEqual({ kind: 'operation', owner: published, ownedKeys: [unused.relativePath], published: true })
    await game.store.media.releaseClaims(published)
    expect((await game.store.media.pendingCleanup()).items).toEqual([])
    expect(await game.store.media.get(unused.id)).toEqual(unused)
  })
  it('atomically adopts ALL import assets with pack publication even if the process crashes before acknowledgement/release', async () => {
    const game = await fixture(), owner = { kind: 'operation' as const, id: 'publish-crash' }
    const used = await upload(game.store, 'songs/used.mp3', 4, owner)
    const unused = await upload(game.store, 'songs/unused.mp3', 5, owner)
    const input = { ...game.pack, categories: [{ ...game.pack.categories[0]!, clues: [{
      ...game.pack.categories[0]!.clues[0]!, mediaAssetId: used.id,
    }] }] }
    game.library.fail = { code: 503, after: true, when: (writes) => writes.some((write) => write.type !== 'delete' && write.doc.kind === 'packReceipt') }
    await game.packs.replace(game.pack.id, input, owner)
    // Do not call completeOperation: simulate restart at the exact publication/ack gap.
    expect((await game.store.media.pendingCleanup()).items).toContainEqual({
      kind: 'operation', owner, ownedKeys: [used.relativePath, unused.relativePath], published: true,
    })
    const storage: MediaStorage = {
      info: { kind: 'filesystem', directory: 'offline-test-unused' },
      stat: async () => { throw new Error('Published operation must not inspect/delete Blob keys') },
      delete: async () => { throw new Error('Published operation must not delete Blob keys') },
      write: async () => { throw new Error('Not used') },
      read: async () => { throw new Error('Not used') },
    }
    await recoverMediaOperations(new MediaRepository(game.store), storage)
    expect(await game.store.media.get(used.id)).toEqual(used)
    expect(await game.store.media.get(unused.id)).toEqual(unused)
    expect((await game.store.media.pendingCleanup()).items).toEqual([])
    const failedOwner = { kind: 'operation' as const, id: 'failed-publication' }
    const orphan = await upload(game.store, 'songs/failed.mp3', 7, failedOwner)
    const latest = (await game.store.packs.get(game.pack.id))!
    game.library.fail = { code: 412, when: (writes) => writes.some((write) => write.type !== 'delete' && write.doc.kind === 'packReceipt') }
    await expect(game.packs.replace(game.pack.id, { ...latest, title: 'Must not publish' }, failedOwner)).rejects.toMatchObject({ code: 'conflict' })
    const deleted: string[] = []
    const cleanupStorage: MediaStorage = { ...storage,
      delete: async (key) => { deleted.push(key) }, stat: async () => undefined }
    await game.store.recover()
    await recoverMediaOperations(new MediaRepository(game.store), cleanupStorage)
    expect(deleted).toEqual([orphan.relativePath])
    expect(await game.store.media.get(orphan.id)).toBeUndefined()
    expect(await game.store.media.get(unused.id)).toEqual(unused)
  })
  it.each(['music', 'final', 'forced'] as const)('settles 50 active players through the same engine for %s', async (mode) => {
    const game = await fixture()
    const asset = await upload(game.store, 'songs/music.mp3', 5)
    const updated = (await game.packs.replace(game.pack.id, { ...game.pack, categories: [{ title: 'Music', clues: [{
      type: 'music_free_text', boardValue: 100, prompt: 'Song?', mediaAssetId: asset.id,
      finalQuestion: mode === 'final', config: { correctAnswer: 'Song', acceptedAnswers: ['Song'] },
    }] }] }))!
    game.room = (await game.rooms.create(game.pack.id, { ...settings, speedBonusMax: 0 }, 5)).room
    game.clueId = updated.categories[0]!.clues[0]!.id
    const players = []
    for (let index = 0; index < 50; index++) players.push((await game.rooms.join(game.room, `Player ${index}`)).player)
    game.room = await game.engine.startGame(game.room)
    if (mode === 'final') {
      for (const player of players) await game.engine.adjustScore(game.room, player.id, 100, 'Seed final')
      game.room = await game.engine.startFinalRound(game.room)
      for (const player of players) await game.engine.submitFinalWager(game.room, player.id, 10)
      game.room = await game.engine.startFinalQuestion(game.room)
      // All missing answers must appear as synthetic outcomes without 50 answer inserts.
    } else {
      if (mode === 'forced') game.room = await game.rooms.saveState(game.room.id, { ...game.room.state,
        specialAssignments: { [game.clueId]: 'forced_player' } }, 'active', game.room.stateVersion)
      game.room = await game.engine.selectClue(game.room, game.clueId)
      if (mode === 'forced') {
        game.room = await game.engine.submitSpecialVote(game.room, players[0]!.id, players[1]!.id)
        game.room = await game.engine.resolveSpecialVote(game.room)
        await game.engine.submitAnswer(game.room, players[1]!.id, 'wrong')
      } else for (const player of players) await game.engine.submitAnswer(game.room, player.id, 'Song')
    }
    const before = game.games.batches.length
    game.room = await game.engine.closeAnswers(game.room)
    const loaded = await game.store.rooms.load(game.room.ref)
    expect(loaded.activeScores).toHaveLength(50)
    if (mode === 'music') expect(loaded.activeScores.every(({ score }) => score === 100)).toBe(true)
    if (mode === 'final') expect(loaded.activeScores.every(({ score }) => score === 90)).toBe(true)
    if (mode === 'forced') expect(loaded.activeScores.filter(({ score }) => score === 100)).toHaveLength(49)
    const commit = game.games.batches.slice(before).find((batch) => batch.writes.some((write) => write.type !== 'delete' && write.doc.kind === 'result'))
    expect(commit?.writes).toHaveLength(4)
    const attempt = { clueId: game.clueId, attempt: loaded.room.state.attempt! }
    const outcomes = await game.store.rooms.results(game.room.ref, attempt)
    if (mode === 'final') expect(outcomes.items).toHaveLength(50)
    game.room = await game.engine.skipClue(game.room)
    const after = await game.store.rooms.load(game.room.ref)
    expect(after.activeScores.every(({ score }) => score === (mode === 'final' ? 100 : 0))).toBe(true)
    expect((await game.store.rooms.appliedAwards(game.room.ref, attempt))).toEqual([])
  })
  it('rejects unsupported versions, incomplete config, stale stages and excessive batch/item payload before writing', async () => {
    const game = await fixture(), current = await game.store.rooms.load(game.room.ref)
    await game.store.rooms.prepareResult(current.ref, current.revision, 'abandoned', 0, { entries: [], awards: [] })
    await game.rooms.join(game.room, 'Alex')
    await expect(game.store.rooms.prepareResult(current.ref, current.revision, 'stale', 0, { entries: [], awards: [] })).rejects.toThrow('Room changed')
    await game.store.recover()
    expect([...game.games.documents.values()].some(({ kind }) => kind === 'resultChunk')).toBe(false)
    const quota = (await game.library.read(LIBRARY_PK, 'quota'))!
    Reflect.set(quota, 'schemaVersion', 2)
    game.library.seed(quota)
    await expect(game.store.recover()).rejects.toMatchObject({ code: 'unsupported_version' })
    expect(() => validateBatch('x', Array.from({ length: 101 }, (_, index) => ({ type: 'create', doc: document('x', String(index), 'test', {}) })))).toThrow('100')
    expect(() => validateBatch('x', [{ type: 'create', doc: document('x', 'huge', 'test', { value: 'x'.repeat(MAX_BATCH_BYTES) }) }])).toThrow('payload')
    expect(() => cloudConfig({ FRIENDS_TRIVIA_MODE: 'cloud' })).toThrow('required')
    await expect(openCosmosStore(config)).rejects.toThrow('explicit cloud mode')
    await expect(openCosmosStore({ ...config, mode: 'cloud' } as DeploymentConfig)).rejects.toThrow('incomplete')
  })
  it('gates live credentials on approved exact isolated targets and namespaces every test write/read/query', async () => {
    const environment = {
      FRIENDS_TRIVIA_COSMOS_LIVE: 'approved-isolated-target',
      COSMOS_TEST_TARGET_VERIFIED: 'approved-account-and-isolated-database',
      COSMOS_ENDPOINT: 'https://friends-trivia-offline.documents.azure.com:443/',
      COSMOS_TEST_EXPECTED_ENDPOINT: 'https://friends-trivia-offline.documents.azure.com:443/',
      COSMOS_DATABASE: 'friends-trivia-tests', COSMOS_GAMES_CONTAINER: 'games', COSMOS_LIBRARY_CONTAINER: 'library',
      AZURE_STORAGE_CONTAINER: 'songs-tests', FRIENDS_TRIVIA_TEST_RUN_ID: 'offline-owned-run-1234',
      COSMOS_TEST_ACCOUNT_RESOURCE_ID: '/subscriptions/299e641c-a5ad-4736-a74e-31ee5da9aef6/resourceGroups/friendsTrivia-app/providers/Microsoft.DocumentDB/databaseAccounts/friends-trivia-offline',
    }
    expect(validateCosmosTestTarget(environment).database).toBe('friends-trivia-tests')
    expect(() => validateCosmosTestTarget({ ...environment, COSMOS_DATABASE: 'friends-trivia' })).toThrow('isolated')
    expect(() => validateCosmosTestTarget({ ...environment, COSMOS_TEST_TARGET_VERIFIED: '' })).toThrow('verified')
    expect(() => validateCosmosTestTarget({ ...environment, COSMOS_TEST_ACCOUNT_RESOURCE_ID: '' })).toThrow('verified')
    expect(() => validateCosmosTestTarget({ ...environment, COSMOS_ENDPOINT: 'https://other.documents.azure.com:443/' })).toThrow('isolated')
    const sdk = new FakeCosmos(), owned = new OwnedTestAccess(sdk, environment.FRIENDS_TRIVIA_TEST_RUN_ID)
    sdk.seed(document('same-partition', 'unowned', 'test', { value: 'Do not delete' }))
    await owned.batch('same-partition', [{ type: 'create', doc: document('same-partition', 'owned', 'test', {}) }])
    expect((await owned.query({ filters: [] })).items.map(({ id }) => id)).toEqual(['owned'])
    expect(await owned.read('same-partition', 'unowned')).toBeUndefined()
    const doc = (await owned.read('same-partition', 'owned'))!
    await owned.batch('same-partition', [{ type: 'delete', id: doc.id, etag: doc._etag! }])
    expect(await sdk.read('same-partition', 'unowned')).toBeDefined()
  })
  it('returns committed publication success when post-commit cleanup fails, retaining the durable journal for recovery', async () => {
    const game = await fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    game.library.fail = { code: 503, when: (writes) => writes.some((write) => write.type === 'delete') }
    const result = await game.packs.replace(game.pack.id, { ...game.pack, title: 'Committed' })
    expect(result?.title).toBe('Committed')
    expect((await game.store.packs.get(game.pack.id))?.title).toBe('Committed')
    expect(log).toHaveBeenCalledWith('Cosmos pack cleanup remains pending', expect.objectContaining({ status: 503 }))
    expect([...game.library.documents.values()].some(({ kind }) => kind === 'publication')).toBe(true)
    await game.store.recover()
    expect([...game.library.documents.values()].some(({ kind }) => kind === 'publication')).toBe(false)
    const created = await game.store.packs.create({ title: 'Stable create' }, 'stable-pack-create')
    await game.packs.replace(created.id, { title: 'Changed afterwards', status: 'draft', categories: [] })
    expect((await game.store.packs.create({ title: 'Stable create' }, 'stable-pack-create')).title).toBe('Changed afterwards')
    await expect(game.store.packs.create({ title: 'Different operation', description: '' }, 'stable-pack-create')).rejects.toThrow('reused')
  })
  it('retains creation tombstones so retrying a deleted operation cannot recycle an external room ID', async () => {
    const game = await fixture()
    const created = await game.store.rooms.create(game.pack.id, settings, 'creator-token-hash', 4, 'stable-create')
    expect((await game.store.rooms.create(game.pack.id, settings, 'creator-token-hash', 4, 'stable-create')).ref).toEqual(created.ref)
    const ended = await game.store.rooms.commit({ ref: created.ref, expectedRevision: created.revision, operationId: 'end-stable',
      at: new Date().toISOString(), change: { kind: 'none' },
      state: { value: { ...created.room.state, phase: 'FINISHED' }, status: 'abandoned', nextStateVersion: 1, joiningLocked: true } })
    expect(await game.store.history.removeCompleted(ended.ref.id)).toBe('deleted')
    await expect(game.store.rooms.create(game.pack.id, settings, 'creator-token-hash', 4, 'stable-create')).rejects.toThrow('was deleted')
    await expect(game.store.rooms.create(game.pack.id, settings, 'different-hash', 4, 'stable-create')).rejects.toThrow('reused')
  })
  it('does not publish a partially staged result or a stale submission/window, and never exposes uncommitted result chunks', async () => {
    const game = await fixture(), joined = await game.rooms.join(game.room, 'Alex')
    game.room = await game.engine.startGame(game.room)
    game.room = await game.engine.selectClue(game.room, game.clueId)
    const current = await game.store.rooms.load(game.room.ref), attempt = { clueId: game.clueId, attempt: current.room.state.attempt! }
    await expect(game.store.rooms.commit({ ref: current.ref, expectedRevision: current.revision, operationId: 'stale-window', at: new Date().toISOString(),
      change: { kind: 'submission', attempt, window: 999, clue: (await game.store.rooms.clue(game.room.ref, game.clueId))!,
        submission: { id: 'stale', playerId: joined.player.id, answer: 50, elapsedMs: 1, receivedAt: new Date().toISOString() } } })).rejects.toMatchObject({ code: 'stale_attempt' })
    await game.store.rooms.prepareResult(current.ref, current.revision, 'incomplete', 0, { entries: [], awards: [] })
    expect((await game.store.rooms.results(current.ref, attempt)).items).toEqual([])
    await expect(game.store.rooms.commit({ ref: current.ref, expectedRevision: current.revision, operationId: 'incomplete-close', at: new Date().toISOString(),
      state: { value: { ...current.room.state, phase: 'ANSWERS_CLOSED' }, status: 'active', nextStateVersion: current.room.stateVersion + 1, joiningLocked: false },
      change: { kind: 'settle', result: { id: 'incomplete', attempt, clue: (await game.store.rooms.clue(game.room.ref, game.clueId))!,
        entries: [], awards: [], activeScores: current.activeScores, stagedChunks: 2 } } })).rejects.toThrow('incomplete')
    expect((await game.store.rooms.load(current.ref)).room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect((await game.store.rooms.load(current.ref)).activeScores[0]?.score).toBe(0)
  })
  it('stores maximum-size packs in immutable clue documents rather than one oversized pack/room JSON item', async () => {
    const game = await fixture()
    const pack = (await game.packs.replace(game.pack.id, { title: 'Large pack', status: 'ready',
      categories: Array.from({ length: 12 }, (_, category) => ({
        title: `Category ${category}`, clues: Array.from({ length: 20 }, (_, clue) => ({
          type: 'price_slider', boardValue: 100, prompt: `${clue} ${'x'.repeat(10_000)}`,
          config: { correctPrice: 50, min: 0, max: 100 },
        })),
      })),
    }))!
    expect(Buffer.byteLength(JSON.stringify(pack))).toBeGreaterThan(2_000_000)
    const created = await game.rooms.create(pack.id, settings, 5)
    expect(await game.store.rooms.board(created.room.ref)).toHaveLength(240)
    expect([...game.games.documents.values(), ...game.library.documents.values()]
      .every((doc) => Buffer.byteLength(JSON.stringify(doc)) < 900_000)).toBe(true)
    expect([...game.games.batches, ...game.library.batches]
      .every((batch) => batch.writes.length <= 100 && batch.bytes < MAX_BATCH_BYTES)).toBe(true)
  })
  it('does not lose obsolete revision cleanup ownership when the last frozen room deletion partially fails', async () => {
    const game = await fixture(), asset = await upload(game.store, 'songs/last-pin.mp3', 1)
    const pack = (await game.packs.replace(game.pack.id, { ...game.pack, categories: [{
      ...game.pack.categories[0]!, clues: [{ ...game.pack.categories[0]!.clues[0]!, mediaAssetId: asset.id }],
    }] }))!
    const created = await game.rooms.create(pack.id, settings, 5)
    await game.packs.replace(pack.id, { title: pack.title, status: 'draft', categories: [] })
    await game.engine.endSession(created.room)
    game.library.fail = { code: 503, when: (writes) => writes.some((write) => write.type === 'delete' && write.id.startsWith('packclue:')) }
    await expect(game.store.history.removeCompleted(created.room.id)).rejects.toThrow('Cosmos request failed')
    expect([...game.library.documents.values()].some((doc) => doc.kind === 'packPin' && Reflect.get(doc, 'revision') === pack.revision)).toBe(true)
    await expect(game.store.media.beginDelete(asset.id, 'still-held')).rejects.toMatchObject({ code: 'media_referenced' })
    await game.store.recover()
    expect(await game.store.media.beginDelete(asset.id, 'after-recovery')).toBeDefined()
  })
  it('charges a successful uncertain upload once and cannot reset a missing production quota counter over existing assets', async () => {
    const game = await fixture(), reservation = await game.store.media.reserveUpload('uncertain-upload', ['songs/uncertain.mp3'])
    const grown = await game.store.media.growReservation(reservation, 10)
    const input = { relativePath: 'songs/uncertain.mp3', originalName: 'file.mp3', mimeType: 'audio/mpeg', sizeBytes: 7 }
    game.library.fail = { code: 503, after: true }
    const asset = await game.store.media.commitUploaded(grown, input, 7)
    expect(await game.store.media.commitUploaded(grown, input, 7)).toEqual(asset)
    const quota = (await game.library.read<ReturnType<typeof document> & { liveBytes: number; reservedBytes: number }>(LIBRARY_PK, 'quota'))!
    expect(quota.liveBytes).toBe(7)
    expect(quota.reservedBytes).toBe(0)
    await game.library.batch(LIBRARY_PK, [{ type: 'delete', id: 'quota', etag: quota._etag! }])
    await expect(createCosmosStore(game.games, game.library)).rejects.toThrow('quota is missing')
    expect(await game.library.read(LIBRARY_PK, 'quota')).toBeUndefined()
  })
  it('fences public pack deletion versus room snapshot publication without dangling room/media claims', async () => {
    const game = await fixture()
    const results = await Promise.allSettled([
      game.rooms.create(game.pack.id, settings, 5),
      game.store.packs.remove(game.pack.id, 'concurrent-delete'),
    ])
    expect(results[1]?.status).toBe('fulfilled')
    expect(await game.store.packs.get(game.pack.id)).toBeUndefined()
    await game.store.recover()
    expect([...game.games.documents.values()].some((doc) => doc.kind === 'room')).toBe(false)
    expect([...game.library.documents.values()].some((doc) => doc.kind === 'packPin' || doc.kind === 'claim')).toBe(false)
  })
  it('checks score overflow for kicked players before manual adjustments or settlement can commit', async () => {
    const game = await fixture(), joined = await game.rooms.join(game.room, 'Large score')
    const current = await game.store.rooms.load(game.room.ref)
    await game.store.rooms.commit(adjustment(current.ref, current.revision, joined.player.id, 'seed-max-safe', Number.MAX_SAFE_INTEGER))
    game.room = await game.engine.startGame(game.room)
    game.room = await game.engine.selectClue(game.room, game.clueId)
    await game.engine.submitAnswer(game.room, joined.player.id, 50)
    await game.rooms.kickPlayer(game.room.id, joined.player.id)
    const loaded = await game.store.rooms.load(game.room.ref)
    await expect(game.store.rooms.commit(adjustment(loaded.ref, loaded.revision, joined.player.id, 'overflow-inactive', 1))).rejects.toThrow('safe integer')
    await expect(game.engine.closeAnswers(game.room)).rejects.toThrow('safe integer')
    expect((await game.store.rooms.load(game.room.ref)).room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect((await game.store.history.players(game.room.id)).items[0]?.score).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('uses SDK ifMatch and inspects operation status, with bounded throttle retry and no successful RAM fallback', async () => {
    const client = new CosmosClient({ endpoint: 'https://offline.documents.azure.com', key: 'not-a-real-key' })
    const container = client.database('offline').container('offline'), access = new SdkCosmosAccess(container)
    const batch = vi.spyOn(container.items, 'batch').mockRejectedValue(new CosmosFailure(412))
    const doc = { ...document('x', 'doc', 'test', {}), _etag: 'old' }
    await expect(access.batch('x', [{ type: 'replace', doc, etag: 'old' }])).rejects.toMatchObject({ code: 412 })
    expect(batch.mock.calls[0]?.[0][0]).toMatchObject({ operationType: 'Replace', ifMatch: 'old' })
    await expect(access.batch('x', [{ type: 'delete', id: 'doc', etag: 'old' }])).rejects.toMatchObject({ code: 412 })
    expect(batch.mock.calls[1]?.[0][0]).toMatchObject({ operationType: 'Delete', ifMatch: 'old' })
    batch.mockResolvedValue({ headers: {}, code: 200, result: [{ statusCode: 409, requestCharge: 1 }] })
    await expect(access.batch('x', [{ type: 'create', doc }])).rejects.toMatchObject({ code: 409 })
    batch.mockResolvedValueOnce({ headers: {}, code: 200, result: [{ statusCode: 424, requestCharge: 1 }, { statusCode: 412, requestCharge: 1 }] })
    await expect(access.batch('x', [{ type: 'create', doc }, { type: 'replace', doc, etag: 'old' }])).rejects.toMatchObject({ code: 412 })
    let attempts = 0
    await expect(retry(async () => { attempts++; throw new CosmosFailure(429) })).rejects.toMatchObject({ code: 429 })
    expect(attempts).toBe(5)
    client.dispose()
  })
  it('accepts exhausted empty SDK feeds but rejects incomplete pages', async () => {
    const client = new CosmosClient({ endpoint: 'https://offline.documents.azure.com', key: 'not-a-real-key' })
    try {
      const container = client.database('offline').container('offline'), access = new SdkCosmosAccess(container)
      const iterator = container.items.query({ query: 'SELECT * FROM c ORDER BY c.updatedAt DESC' })
      vi.spyOn(container.items, 'query').mockReturnValue(iterator)
      const response = new FeedResponse([], {}, false, new CosmosDiagnostics())
      Object.defineProperty(response, 'resources', { value: undefined })
      vi.spyOn(iterator, 'fetchNext').mockResolvedValue(response)
      expect(await access.query({ filters: [], order: [{ field: 'updatedAt', descending: true }] })).toEqual({ items: [] })
      Object.defineProperty(response, 'hasMoreResults', { value: true })
      await expect(access.query({ filters: [] })).rejects.toMatchObject({ code: 503 })
    } finally {
      client.dispose()
    }
  })
  it('enables SDK continuation tokens and advances empty progress pages without losing results', async () => {
    const client = new CosmosClient({ endpoint: 'https://offline.documents.azure.com', key: 'not-a-real-key' })
    try {
      const container = client.database('offline').container('offline'), access = new SdkCosmosAccess(container)
      const iterator = container.items.query({ query: 'SELECT * FROM c' })
      const query = vi.spyOn(container.items, 'query').mockReturnValue(iterator)
      const empty = new FeedResponse([], { 'x-ms-continuation': 'next-page' }, true, new CosmosDiagnostics())
      const doc = document('x', 'item', 'test', {})
      const next = new FeedResponse([doc], { 'x-ms-continuation': 'remaining-page' }, true, new CosmosDiagnostics())
      const fetch = vi.spyOn(iterator, 'fetchNext').mockResolvedValueOnce(empty).mockResolvedValueOnce(next)
      expect(await access.query({ filters: [] }, { limit: 17, cursor: 'previous-page' }))
        .toEqual({ items: [doc], cursor: 'remaining-page' })
      expect(query.mock.calls[0]?.[1]).toMatchObject({ enableQueryControl: true, maxItemCount: 17, continuationToken: 'previous-page' })
      fetch.mockResolvedValueOnce(new FeedResponse([], {}, true, new CosmosDiagnostics())).mockResolvedValueOnce(next)
      expect((await access.query({ filters: [] })).items).toEqual([doc])
      fetch.mockClear()
      fetch.mockResolvedValue(empty)
      await expect(access.query({ filters: [] }, { cursor: 'next-page' })).rejects.toMatchObject({ code: 503 })
      expect(fetch).toHaveBeenCalledTimes(100)
    } finally {
      client.dispose()
    }
  })
})
