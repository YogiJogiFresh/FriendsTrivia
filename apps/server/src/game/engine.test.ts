import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../database.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { GameEngine } from './engine.js'

const databases: ReturnType<typeof openDatabase>[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
})

function createGame() {
  const database = openDatabase(':memory:')
  databases.push(database)
  const packs = new PackRepository(database)
  const rooms = new RoomRepository(database)
  const engine = new GameEngine(database, rooms, 'http://192.168.1.10:3000')
  const pack = packs.create({ title: 'Party' }) as { id: string }
  database
    .prepare(
      `INSERT INTO media_assets
       (id, relative_path, original_name, mime_type, size_bytes)
       VALUES ('test-media', 'songs/test.mp3', 'test.mp3', 'audio/mpeg', 1)`,
    )
    .run()
  const packInput = {
    title: 'Party',
    status: 'ready' as const,
    categories: [
      {
        title: 'Hits',
        clues: [
          {
            type: 'music_free_text',
            boardValue: 200,
            prompt: 'Name the song',
            timerSeconds: 30,
            mediaAssetId: 'test-media',
            revealMediaAssetId: 'test-media',
            config: {
              correctAnswer: 'Dancing Queen',
              acceptedAnswers: ['Dancing Queen'],
              revealGif: {
                provider: 'giphy',
                url: 'https://media.giphy.com/media/celebrate/giphy.gif',
                previewUrl: 'https://media.giphy.com/media/celebrate/100w.gif',
                alt: 'Celebration',
                sourceUrl: 'https://giphy.com/gifs/celebrate',
              },
            },
          },
          {
            type: 'price_slider',
            boardValue: 400,
            prompt: 'What did it cost?',
            timerSeconds: 30,
            config: { correctPrice: 100, min: 0, max: 200, step: 1 },
          },
        ],
      },
    ],
  }
  const savedPack = packs.replace(pack.id, packInput) as {
    categories: Array<{ clues: Array<{ id: string }> }>
  }
  const created = rooms.create(
    pack.id,
    {
      timerSeconds: 30,
      speedBonusMax: 100,
      priceRankPercentages: [1, 0.5],
      uniqueNicknames: true,
    },
    4,
  )
  const playerOne = rooms.join(created.room, 'Alex')
  const playerTwo = rooms.join(created.room, 'Sam')
  return {
    database,
    packs,
    pack,
    packInput,
    rooms,
    engine,
    room: created.room,
    clueIds: savedPack.categories[0]?.clues.map((clue) => clue.id) ?? [],
    playerOne: playerOne.player,
    playerTwo: playerTwo.player,
  }
}

describe('game engine', () => {
  it('publishes a LAN-safe player join URL', () => {
    const game = createGame()
    expect(game.engine.publicSnapshot(game.room).joinUrl).toBe(
      `http://192.168.1.10:3000/play/${game.room.code}`,
    )
  })

  it('publishes the configured answer reveal audio', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')

    expect(game.engine.publicSnapshot(room).activeClue).toMatchObject({
      mediaUrl: '/api/media/test-media/stream',
      revealMediaUrl: '/api/media/test-media/stream',
    })
  })

  it('keeps a reveal GIF hidden until the answer is revealed', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    expect(game.engine.publicSnapshot(room).activeClue?.revealGif).toBeUndefined()

    room = game.engine.closeAnswers(room)
    room = game.engine.reveal(room)

    expect(game.engine.publicSnapshot(room).activeClue?.revealGif).toMatchObject({
      provider: 'giphy',
      alt: 'Celebration',
    })
  })

  it('runs a music clue and records score events once', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect(room.state.deadline).toBeDefined()
    game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen!')
    game.engine.submitAnswer(room, game.playerTwo.id, 'Wrong song')
    room = game.engine.closeAnswers(room)

    const scores = game.rooms.scores(room.id)
    expect(scores.find((score) => score.playerId === game.playerOne.id)?.score).toBeLessThanOrEqual(200)
    expect(scores.find((score) => score.playerId === game.playerOne.id)?.score).toBeGreaterThan(0)
    expect(scores.find((score) => score.playerId === game.playerTwo.id)?.score).toBe(0)
    expect(() => game.engine.closeAnswers(room)).toThrow('Answers are not open')
    const edited = structuredClone(game.packInput)
    const originalPrompt = edited.categories[0]?.clues[0]?.prompt
    if (edited.categories[0]?.clues[0]) edited.categories[0].clues[0].prompt = 'Edited prompt'
    expect(() => game.packs.replace(game.pack.id, edited)).not.toThrow()
    const historical = game.database
      .prepare('SELECT clue_prompt AS prompt FROM submissions WHERE room_id = ?')
      .get(room.id) as { prompt: string }
    expect(historical.prompt).toBe(originalPrompt)
  })

  it('ranks price guesses without rewarding overbids', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[1] ?? '')
    game.engine.submitAnswer(room, game.playerOne.id, 90)
    game.engine.submitAnswer(room, game.playerTwo.id, 101)
    room = game.engine.closeAnswers(room)
    room = game.engine.reveal(room)

    const scores = game.rooms.scores(room.id)
    expect(scores.find((score) => score.playerId === game.playerOne.id)?.score).toBe(360)
    expect(scores.find((score) => score.playerId === game.playerTwo.id)?.score).toBe(0)
    expect(game.engine.publicSnapshot(room).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: game.playerOne.id, pointsAwarded: 360 }),
        expect.objectContaining({ playerId: game.playerTwo.id, pointsAwarded: 0 }),
      ]),
    )
  })

  it('preserves active answer time across a pause', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    room = game.engine.pause(room)
    room = game.engine.resume(room)

    const resumedAt = Date.parse(room.state.startedAt ?? '')
    expect(Date.now() - resumedAt).toBeLessThan(1_000)
    game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    room = game.engine.closeAnswers(room)
    expect(game.rooms.scores(room.id)[0]?.score).toBeLessThanOrEqual(200)
    expect(game.rooms.scores(room.id)[0]?.score).toBeGreaterThan(0)
  })

  it('keeps the last ordinary clue playable when no Final Question is configured', () => {
    const game = createGame()
    game.database
      .prepare('UPDATE clues SET archived = 1 WHERE id = ?')
      .run(game.clueIds[1])
    let room = game.engine.startGame(game.room)

    room = game.engine.selectClue(room, game.clueIds[0] ?? '')

    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect(game.engine.publicSnapshot(room).hasFinalQuestion).toBe(false)
  })

  it('returns a clue to the board as unplayed and removes its answers and score', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    room = game.engine.closeAnswers(room)
    expect(game.rooms.scores(room.id)[0]?.score).toBeGreaterThan(0)

    room = game.engine.goBack(room)

    expect(room.state.phase).toBe('BOARD')
    expect(room.state.activeClueId).toBeUndefined()
    expect(room.state.usedClueIds).not.toContain(game.clueIds[0])
    expect(game.rooms.scores(room.id)[0]?.score).toBe(0)
    expect(
      game.database.prepare('SELECT COUNT(*) AS count FROM submissions WHERE room_id = ?').get(room.id),
    ).toEqual({ count: 0 })
    expect(() => game.engine.selectClue(room, game.clueIds[0] ?? '')).not.toThrow()
  })

  it('resets the current clue with a fresh timer and empty answers', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    room = game.engine.closeAnswers(room)

    room = game.engine.resetClue(room)

    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect(room.state.deadline).toBeDefined()
    expect(game.rooms.scores(room.id)[0]?.score).toBe(0)
    expect(
      game.database.prepare('SELECT COUNT(*) AS count FROM submissions WHERE room_id = ?').get(room.id),
    ).toEqual({ count: 0 })
    expect(() => game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')).not.toThrow()
  })

  it('finishes when the final question is skipped', () => {
    const game = createGame()
    game.database
      .prepare('UPDATE clues SET archived = 1 WHERE id = ?')
      .run(game.clueIds[1])
    game.database
      .prepare('UPDATE clues SET is_final = 1 WHERE id = ?')
      .run(game.clueIds[0])
    let room = game.engine.startGame(game.room)
    expect(game.engine.publicSnapshot(room)).toMatchObject({
      board: [],
      hasFinalQuestion: true,
    })
    room = game.engine.startFinalRound(room)
    game.engine.submitFinalWager(room, game.playerOne.id, 0)
    game.engine.submitFinalWager(room, game.playerTwo.id, 0)
    room = game.engine.startFinalQuestion(room)
    room = game.engine.skipClue(room)
    expect(room.state.phase).toBe('FINISHED')
    expect(room.status).toBe('finished')
  })

  it('requires wagers and awards the fixed wager for the final question', () => {
    const game = createGame()
    game.database
      .prepare('UPDATE clues SET is_final = 1 WHERE id = ?')
      .run(game.clueIds[0])
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[1] ?? '')
    game.engine.submitAnswer(room, game.playerOne.id, 90)
    game.engine.submitAnswer(room, game.playerTwo.id, 101)
    room = game.engine.closeAnswers(room)
    room = game.engine.reveal(room)
    room = game.engine.showLeaderboard(room)
    game.engine.adjustScore(room, game.playerTwo.id, 50, 'Final wager seed')

    expect(() => game.engine.selectClue(room, game.clueIds[0] ?? '')).toThrow(
      'Final Question control',
    )
    room = game.engine.startFinalRound(room)
    game.engine.submitFinalWager(room, game.playerOne.id, 100)
    expect(() => game.engine.startFinalQuestion(room)).toThrow('Every player')
    expect(() => game.engine.submitFinalWager(room, game.playerTwo.id, 51)).toThrow(
      '0 to 50',
    )
    game.engine.submitFinalWager(room, game.playerTwo.id, 50)

    room = game.engine.startFinalQuestion(room)
    game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    game.engine.submitAnswer(room, game.playerTwo.id, 'Wrong')
    game.database
      .prepare('UPDATE submissions SET elapsed_ms = 29999 WHERE room_id = ? AND player_id = ?')
      .run(room.id, game.playerOne.id)
    room = game.engine.closeAnswers(room)
    room = game.engine.reveal(room)

    expect(game.engine.publicSnapshot(room).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: game.playerOne.id, pointsAwarded: 100 }),
        expect.objectContaining({ playerId: game.playerTwo.id, pointsAwarded: -50 }),
      ]),
    )
    expect(game.rooms.scores(room.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: game.playerOne.id, score: 460 }),
        expect.objectContaining({ playerId: game.playerTwo.id, score: 0 }),
      ]),
    )
  })

  it('allows the host to start a configured Final Question before board clues are complete', () => {
    const game = createGame()
    game.database
      .prepare('UPDATE clues SET is_final = 1 WHERE id = ?')
      .run(game.clueIds[0])
    let room = game.engine.startGame(game.room)

    room = game.engine.startFinalRound(room)

    expect(room.state.phase).toBe('FINAL_WAGER')
    expect(room.state.activeClueId).toBe(game.clueIds[0])
    expect(game.engine.publicSnapshot(room).board).toHaveLength(1)
  })

  it('closes an answer round whose recovered timer already expired', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    room = game.engine.pause(room)
    room = game.rooms.saveState(
      room.id,
      { ...room.state, remainingMs: 0 },
      'paused',
      room.stateVersion,
    )
    room = game.engine.resume(room)
    expect(room.state.phase).toBe('ANSWERS_CLOSED')
  })

  it('ends and abandons a live session from any game phase', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')

    room = game.engine.endSession(room)

    expect(room.state.phase).toBe('FINISHED')
    expect(room.state.activeClueId).toBeUndefined()
    expect(room.status).toBe('abandoned')
    expect(room.completedAt).not.toBeNull()
  })
})
