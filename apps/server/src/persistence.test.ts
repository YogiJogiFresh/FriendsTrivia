import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openDatabase } from './database.js'
import { GameEngine } from './game/engine.js'
import * as ids from './ids.js'
import type { GameSettings } from './game/types.js'
import { Persistence } from './persistence.js'
import { MediaRepository } from './repositories/media.js'
import { PackRepository } from './repositories/packs.js'
import { RoomRepository } from './repositories/rooms.js'
import { registerHistoryRoutes } from './routes/history.js'
import { registerGifRoutes } from './routes/gifs.js'
import { registerPackRoutes } from './routes/packs.js'
import { registerRoomRoutes } from './routes/rooms.js'

const settings: GameSettings = {
  timerSeconds: 30, speedBonusMax: 100, priceRankPercentages: [1, 0.5],
  uniqueNicknames: true, teams: [], specials: [],
}

describe('SQLite domain conformance', () => {
    let database: Persistence
    let engine: GameEngine
    let rooms: RoomRepository
    let packs: PackRepository

    beforeEach(async () => {
      database = new Persistence(openDatabase(':memory:'))
      rooms = new RoomRepository(database)
      packs = new PackRepository(database)
      engine = new GameEngine(database, rooms, 'https://trivia.example', true)
    })

    afterEach(async () => {
      vi.restoreAllMocks()
      engine?.dispose()
      await database.close()
    })

    async function game() {
      const media = new MediaRepository(database)
      const asset = await media.create({ relativePath: 'songs/test.mp3', originalName: 'test.mp3', mimeType: 'audio/mpeg', sizeBytes: 1 })
      const pack = await packs.create({ title: 'Conformance' }) as { id: string }
      const input = {
        title: 'Conformance', status: 'ready' as const,
        categories: [{
          title: 'Music', clues: [{
            type: 'music_free_text', boardValue: 200, prompt: 'Name it',
            mediaAssetId: asset.id, revealMediaAssetId: asset.id,
            config: { correctAnswer: 'Dancing Queen' },
          }, {
            type: 'price_slider', boardValue: 400, prompt: 'Price?',
            config: { correctPrice: 50, min: 0, max: 100 },
          }]
        }],
      }
      const saved = await packs.replace(pack.id, input) as {
        categories: Array<{ id: string; clues: Array<{ id: string }> }>
      }
      const created = await rooms.create(pack.id, settings, 4)
      const player = await rooms.join(created.room, 'Alex')
      const second = await rooms.join(created.room, 'Sam')
      return { ...created, pack, input, saved, player: player.player, second: second.player, asset }
    }

    it('preserves replacement IDs/history, camel-case aggregates and case-insensitive nicknames', async () => {
      const current = await game()
      expect(await packs.list()).toEqual([expect.objectContaining({ categoryCount: 1, clueCount: 2, ordinaryClueCount: 2 })])
      await expect(rooms.join(current.room, 'aLeX')).rejects.toThrow('nickname is already in use')
      for (let index = 0;index < 3;index += 1) {
        await packs.replace(current.pack.id, {
          ...current.input,
          categories: current.input.categories.map((category) => ({
            ...category, id: current.saved.categories[0]!.id,
            clues: category.clues.map((clue, clueIndex) => ({ ...clue, id: current.saved.categories[0]!.clues[clueIndex]!.id })),
          })),
        })
      }
      const saved = await packs.get(current.pack.id)
      expect(saved).toMatchObject({ categories: [{ id: current.saved.categories[0]!.id }] })
      expect(await rooms.scores(current.room.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ playerId: current.player.id, score: 0, connected: true }),
      ]))
      await packs.remove(current.pack.id)
      expect(await rooms.getById(current.room.id)).toBeUndefined()
      expect(await new MediaRepository(database).get(current.asset.id)).toBeDefined()
    })

    it('enforces the 50-player cap under concurrent joining', async () => {
      const current = await game()
      const joined = await Promise.allSettled(Array.from({ length: 49 }, (_, index) => rooms.join(current.room, `Player ${index}`)))
      expect(joined.filter((result) => result.status === 'fulfilled')).toHaveLength(48)
      expect(await rooms.listPlayers(current.room.id)).toHaveLength(50)
    })

    it('retries room-code collisions without hiding unrelated failures', async () => {
      const current = await game()
      const nextCode = current.room.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ'
      vi.spyOn(ids, 'createRoomCode').mockReturnValueOnce(current.room.code).mockReturnValueOnce(nextCode)
      const next = await rooms.create(current.pack.id, settings, 4)
      expect(next.room.code).toBe(nextCode)
      expect(rooms.isHost(next.room, next.hostToken)).toBe(true)
    })

    it('rejects stale versions and rolls back state, snapshots and scores together', async () => {
      const current = await game()
      const started = await engine.startGame(current.room)
      const results = await Promise.allSettled([engine.pause(started), engine.finish(started)])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const latest = (await rooms.getById(started.id))!
      let broadcasts = 0
      engine.on('roomUpdated', () => { broadcasts += 1 })
      await expect(engine.runRoom(latest.id, async () => {
        await engine.adjustScore(latest, current.player.id, 99, 'rollback check')
        await rooms.saveState(latest.id, { ...latest.state, phase: 'FINISHED' }, 'finished', latest.stateVersion)
        throw new Error('injected failure')
      })).rejects.toThrow('injected failure')
      expect((await rooms.getById(latest.id))!.stateVersion).toBe(latest.stateVersion)
      expect((await rooms.scores(latest.id))[0]!.score).toBe(0)
      expect(broadcasts).toBe(0)
    })

    it('rolls back closing/evaluation when scoring fails and can safely retry once', async () => {
      const current = await game()
      let room = await engine.startGame(current.room)
      room = await engine.selectClue(room, current.saved.categories[0]!.clues[0]!.id)
      expect((await engine.publicSnapshot(room)).activeClue?.mediaUrl).toBe(`/api/media/${current.asset.id}/stream?roomCode=${room.code}`)
      await engine.submitAnswer(room, current.player.id, 'Dancing Queen')
      database.sqlite!.exec("CREATE TRIGGER fail_score BEFORE INSERT ON score_events BEGIN SELECT RAISE(ABORT, 'injected score failure'); END")
      let broadcasts = 0
      engine.on('roomUpdated', () => { broadcasts += 1 })
      await expect(engine.closeAnswers(room)).rejects.toThrow('injected score failure')
      expect((await rooms.getById(room.id))!.state).toEqual(room.state)
      expect((await rooms.getById(room.id))!.stateVersion).toBe(room.stateVersion)
      expect((await rooms.scores(room.id))[0]!.score).toBe(0)
      expect(broadcasts).toBe(0)
      database.sqlite!.exec('DROP TRIGGER fail_score')
      room = await engine.closeAnswers(room)
      expect((await rooms.scores(room.id))[0]!.score).toBeGreaterThan(0)
      expect(room.state.phase).toBe('ANSWERS_CLOSED')
      await expect(engine.closeAnswers(room)).rejects.toThrow('Answers are not open')
    })

    it('handles final wagers and missing answers, then voids/reset scores without duplication', async () => {
      const current = await game()
      const input = {
        ...current.input,
        categories: current.input.categories.map((category) => ({
          ...category, id: current.saved.categories[0]!.id,
          clues: category.clues.map((clue, index) => ({
            ...clue, id: current.saved.categories[0]!.clues[index]!.id,
            finalQuestion: index === 1,
          })),
        })),
      }
      await packs.replace(current.pack.id, input)
      let room = await engine.startGame(current.room)
      await engine.adjustScore(room, current.player.id, 100, 'starting score')
      await engine.adjustScore(room, current.second.id, 100, 'starting score')
      room = await engine.startFinalRound(room)
      await engine.submitFinalWager(room, current.player.id, 70)
      await expect(engine.submitFinalWager(room, current.player.id, 70)).rejects.toThrow('already locked')
      await engine.submitFinalWager(room, current.second.id, 40)
      room = await engine.startFinalQuestion(room)
      await engine.submitAnswer(room, current.player.id, 50)
      room = await engine.closeAnswers(room)
      expect(await rooms.scores(room.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ playerId: current.player.id, score: 170 }),
        expect.objectContaining({ playerId: current.second.id, score: 60 }),
      ]))
      room = await engine.resetClue(room)
      expect(await rooms.scores(room.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ playerId: current.player.id, score: 100 }),
        expect.objectContaining({ playerId: current.second.id, score: 100 }),
      ]))
      await engine.submitAnswer(room, current.player.id, 50)
      room = await engine.closeAnswers(room)
      room = await engine.skipClue(room)
      expect(room.status).toBe('finished')
      expect((await rooms.scores(room.id)).map((player) => player.score)).toEqual([100, 100])
    })

    it('orders deadline closure after received answers and scores using receipt time, not storage latency', async () => {
      const current = await game()
      let room = await engine.startGame(current.room)
      room = await engine.selectClue(room, current.saved.categories[0]!.clues[0]!.id)
      const receivedAt = Date.now()
      room = await rooms.saveState(room.id, {
        ...room.state, startedAt: new Date(receivedAt - 1000).toISOString(),
        deadline: new Date(receivedAt + 10).toISOString(),
      }, 'active', room.stateVersion)
      const blocked = engine.runRoom(room.id, () => new Promise<void>((resolve) => setTimeout(resolve, 30)))
      const submission = engine.submitAnswer(room, current.player.id, 'Dancing Queen', receivedAt)
      const closed = engine.closeAnswers(room)
      await blocked
      expect((await submission).receivedAt).toBe(new Date(receivedAt).toISOString())
      const ended = await closed
      expect(ended.state.phase).toBe('ANSWERS_CLOSED')
      const revealed = await engine.reveal(ended)
      expect((await engine.hostSnapshot(revealed)).submissions).toEqual([
        expect.objectContaining({ playerId: current.player.id, elapsedMs: 1000, receivedAt: new Date(receivedAt).toISOString() }),
      ])
      expect((await rooms.scores(room.id))[0]!.score).toBe(193)
      await expect(engine.closeAnswers(revealed)).rejects.toThrow('Answers are not open')
    })

    it('rejects late answers, recovers interrupted games paused and serves equivalent routes/history', async () => {
      const current = await game()
      let room = await engine.startGame(current.room)
      room = await engine.selectClue(room, current.saved.categories[0]!.clues[1]!.id)
      await expect(engine.submitAnswer(room, current.player.id, 50, Date.parse(room.state.deadline!) + 1)).rejects.toThrow('Answers are closed')
      expect(await engine.recoverInterruptedGames()).toBe(1)
      room = (await rooms.getById(room.id))!
      expect(room.state.phase).toBe('PAUSED')
      expect(room.state.previousPhase).toBe('ACCEPTING_ANSWERS')
      room = await engine.resume(room)
      await engine.submitAnswer(room, current.player.id, 50)
      room = await engine.closeAnswers(room)
      await engine.endSession(room)
      const app = Fastify()
      try {
        await registerPackRoutes(app, packs)
        await registerRoomRoutes(app, rooms, engine, 4, () => 'https://trivia.example')
        await registerHistoryRoutes(app, database)
        await registerGifRoutes(app, database, { giphy: undefined, tenor: undefined })
        expect((await app.inject({ method: 'PUT', url: '/api/gifs/providers/giphy', payload: { apiKey: 'test-provider-key' } })).statusCode).toBe(204)
        expect((await app.inject('/api/gifs/providers')).json()).toEqual({ giphy: true, tenor: false })
        const history = await app.inject('/api/history')
        expect(history.statusCode).toBe(200)
        expect(history.json()).toEqual([expect.objectContaining({ packTitle: 'Conformance', playerCount: 2 })])
        expect((await app.inject(`/api/history/${room.id}`)).json().submissions).toEqual([
          expect.objectContaining({ cluePrompt: 'Price?', pointsAwarded: 400 }),
        ])
        expect((await app.inject(`/api/rooms/${room.code}`)).json().phase).toBe('FINISHED')
        expect((await app.inject(`/api/history/${room.id}/export.csv`)).statusCode).toBe(200)
      } finally { await app.close() }
    })
  })
