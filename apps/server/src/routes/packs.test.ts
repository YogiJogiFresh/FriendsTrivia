import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { GameEngine } from '../game/engine.js'
import { registerPackRoutes } from './packs.js'
import { domainFrom } from '../sqliteStore.js'
import { MediaRepository } from '../repositories/media.js'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
})
describe('pack deletion', () => {
  it('preserves price reveal details and rejects invalid text without replacing saved content', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const pack = await packs.create({ title: 'Prices' })
    const app = Fastify()
    await registerPackRoutes(app, packs)
    cleanups.push(async () => { await app.close(); database.close() })
    const config = { correctPrice: 0, min: 0, max: 100, step: 1, prefix: '$',
      revealNotes: 'Free admission\nIncludes all exhibits' }
    const input = { title: 'Prices', categories: [{ title: 'Prices', clues: [
      { type: 'price_slider', boardValue: 100, prompt: 'Price?', config },
    ] }] }
    expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: input })).statusCode).toBe(200)
    for (const revealNotes of [null, 7, [], {}, 'a'.repeat(2001)]) {
      const bad = structuredClone(input)
      Object.assign(bad.categories[0]!.clues[0]!.config, { revealNotes })
      expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: bad })).statusCode).toBe(400)
      expect((await packs.get(pack.id))?.categories[0]?.clues[0]?.config).toEqual(config)
    }
    for (const revealNotes of ['a'.repeat(2000), ' \n ', '', undefined]) {
      const payload = structuredClone(input)
      Object.assign(payload.categories[0]!.clues[0]!.config, { revealNotes })
      expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload })).statusCode).toBe(200)
      const saved = (await app.inject({ method: 'GET', url: `/api/packs/${pack.id}` })).json()
      expect(saved.categories[0].clues[0].config).toEqual(JSON.parse(JSON.stringify({ ...config, revealNotes })))
    }
  })
  it('preserves Link saves, validates existing songs, and nulls deleted slots across archived clues', async () => {
    const database = openDatabase(':memory:')
    cleanups.push(() => { database.close() })
    const store = domainFrom(database), packs = new PackRepository(database), media = new MediaRepository(database)
    const ids: string[] = []
    for (let index = 0; index < 4; index++) ids.push((await media.create({
      relativePath: `songs\\link-${index}.mp3`, originalName: `link-${index}.mp3`, mimeType: 'audio/mpeg', sizeBytes: 10,
    })).id)
    const pack = await packs.create({ title: 'Links' })
    const config = { correctAnswer: 'Connection', acceptedAnswers: ['Connection'], link: {
      mediaAssetIds: ids, hintDelaySeconds: 10, revealNotes: 'First song - First artist\nSecond song - Second artist',
    } }
    const input = { title: 'Links', status: 'ready' as const, categories: [{ title: 'Links', clues: [
      { type: 'music_free_text', boardValue: 100, prompt: 'Connection?', config },
      { type: 'music_free_text', boardValue: 200, prompt: 'Ordinary?', config: { correctAnswer: 'Answer' } },
      { type: 'music_free_text', boardValue: 300, prompt: 'Final?', finalQuestion: true, config: { correctAnswer: 'Answer' } },
    ] }] }
    const saved = (await packs.replace(pack.id, input))!
    expect(saved.categories[0]?.clues[0]?.config).toEqual(config)
    const invalidNotes = structuredClone(input)
    ;(invalidNotes.categories[0]!.clues[0]!.config as typeof config).link.revealNotes = 'a'.repeat(2001)
    await expect(packs.replace(pack.id, invalidNotes)).rejects.toThrow('songs and artists')
    expect((await packs.get(pack.id))?.categories[0]?.clues[0]?.config).toEqual(config)
    expect((await packs.list())[0]).toMatchObject({ ordinaryClueCount: 2, specialEligibleClueCount: 1 })
    const rooms = new RoomRepository(database)
    const { room } = await rooms.create(pack.id, { timerSeconds: 30, speedBonusMax: 0, priceRankPercentages: [1], uniqueNicknames: true }, 4)
    expect((await store.rooms.board(room.ref)).map((entry) => entry.specialEligible)).toEqual([false, true])
    const invalid = structuredClone(input)
    const invalidConfig = invalid.categories[0]!.clues[0]!.config as typeof config
    invalidConfig.link.mediaAssetIds[1] = 'missing'
    await expect(packs.replace(pack.id, invalid)).rejects.toThrow('existing media')
    expect((await packs.get(pack.id))?.revision).toBe(saved.revision)
    await packs.replace(pack.id, input)
    const ticket = (await store.media.beginDelete(ids[1]!, 'delete-link-song'))!
    await expect(store.media.finishDelete(ticket, false)).rejects.toThrow('still exists')
    expect((await packs.get(pack.id))?.categories[0]?.clues[0]?.config).toEqual(config)
    await store.media.finishDelete(ticket, true)
    await store.media.finishDelete(ticket, true)
    const configs = database.prepare("SELECT config_json FROM clues WHERE json_type(config_json, '$.link') IS NOT NULL")
      .all() as Array<{ config_json: string }>
    expect(configs).toHaveLength(2)
    for (const row of configs) expect(JSON.parse(row.config_json)).toEqual({
      ...config, link: { ...config.link, mediaAssetIds: [ids[0], null, ids[2], ids[3]] },
    })
    expect((await packs.list())[0]).toMatchObject({ ordinaryClueCount: 2, specialEligibleClueCount: 1 })
  })
  it.each([
    { type: 'music_free_text', finalQuestion: false },
    { type: 'music_multiple_choice', finalQuestion: false },
    { type: 'music_free_text', finalQuestion: true },
    { type: 'music_multiple_choice', finalQuestion: true },
  ])('saves and plays $type without a song (final: $finalQuestion)', async ({ type, finalQuestion }) => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const rooms = new RoomRepository(database)
    const engine = new GameEngine(database, rooms, 'http://localhost:3000')
    const app = Fastify()
    await registerPackRoutes(app, packs)
    cleanups.push(async () => { engine.dispose(); await app.close(); database.close() })
    const pack = await packs.create({ title: 'Text questions' })
    const config = {
      correctAnswer: 'Answer',
      ...(type === 'music_multiple_choice' ? { choices: ['Answer', 'Other'] } : {}),
    }
    const input = {
      title: 'Text questions', status: 'ready',
      categories: [{ title: 'Trivia', clues: [{
        type, boardValue: 100, prompt: 'Which answer?', finalQuestion, config,
        ...(finalQuestion ? { mediaAssetId: null } : {}),
      }] }],
    }
    expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: input })).statusCode).toBe(200)
    const saved = (await app.inject({ method: 'GET', url: `/api/packs/${pack.id}` })).json()
    expect(saved.status).toBe('ready')
    expect(saved.categories[0].clues[0]).toMatchObject({ mediaAssetId: null, config })
    const invalid = structuredClone(input)
    invalid.categories[0]!.clues[0]!.config.correctAnswer = ''
    expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: invalid })).statusCode).toBe(400)
    if (type === 'music_multiple_choice') {
      const invalidChoices = structuredClone(input)
      invalidChoices.categories[0]!.clues[0]!.config.choices = ['Answer']
      expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: invalidChoices })).statusCode).toBe(400)
    }
    const created = await rooms.create(pack.id, {
      timerSeconds: 30, speedBonusMax: 0, priceRankPercentages: [1], uniqueNicknames: true,
    }, 4)
    const { player } = await rooms.join(created.room, 'Player')
    let room = await engine.startGame(created.room)
    if (finalQuestion) {
      room = await engine.startFinalRound(room)
      await engine.submitFinalWager(room, player.id, 0)
      room = await engine.startFinalQuestion(room)
    } else {
      room = await engine.selectClue(room, saved.categories[0].clues[0].id)
    }
    const snapshot = await engine.publicSnapshot(room)
    expect(snapshot.activeClue).toMatchObject({ prompt: 'Which answer?', mediaUrl: undefined })
    expect(snapshot.activeClue?.answer).toBeUndefined()
    await engine.submitAnswer(room, player.id, 'Answer')
    room = await engine.closeAnswers(room)
    room = await engine.reveal(room)
    expect((await engine.publicSnapshot(room)).activeClue?.answer).toBe('Answer')
    expect((await engine.publicSnapshot(room)).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: player.id, correct: 1 }),
    ]))
  })
  it('persists independent question GIFs and rejects invalid direct links without replacing content', async () => {
    const database = openDatabase(':memory:')
    const packs = new PackRepository(database)
    const pack = await packs.create({ title: 'Question GIFs' })
    const app = Fastify()
    await registerPackRoutes(app, packs)
    cleanups.push(async () => { await app.close(); database.close() })
    const url = 'https://example.com/question.gif?size=large'
    const gif = { provider: 'url', url, previewUrl: url, sourceUrl: url, alt: 'Question' }
    const input = { title: 'Question GIFs', categories: [{ title: 'Prices', clues: [
      { type: 'price_slider', boardValue: 100, prompt: 'Price?', config: {
        correctPrice: 0, min: 0, max: 100, questionGif: gif, revealGif: gif,
      } },
    ] }] }
    expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: input })).statusCode).toBe(200)
    for (const invalid of [null, {}, { provider: 'giphy', url: 'https://media.giphy.com/a.gif',
      previewUrl: 'https://media.giphy.com/a.gif', sourceUrl: 'https://giphy.com/a', alt: 'Question' },
    { ...gif, alt: 'a'.repeat(301) },
    ...['http://example.com/a.gif', 'https://example.com/a.png',
      'https://example.com/' + 'a'.repeat(2000) + '.gif'].map(url => ({ ...gif, url, previewUrl: url, sourceUrl: url }))]) {
      const bad = structuredClone(input)
      Object.assign(bad.categories[0]!.clues[0]!.config, { questionGif: invalid })
      expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: bad })).statusCode).toBe(400)
    }
    expect((await packs.get(pack.id))?.categories[0]?.clues[0]?.config).toEqual(input.categories[0]!.clues[0]!.config)
    const { questionGif: _removed, ...config } = input.categories[0]!.clues[0]!.config
    const removed = { ...input, categories: [{ title: 'Prices', clues: [{ ...input.categories[0]!.clues[0], config }] }] }
    expect((await app.inject({ method: 'PUT', url: `/api/packs/${pack.id}`, payload: removed })).statusCode).toBe(200)
    expect((await packs.get(pack.id))?.categories[0]?.clues[0]?.config).toEqual(config)
  })
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
