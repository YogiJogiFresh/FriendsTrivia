import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../database.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { GameEngine } from './engine.js'
import type { SpecialType } from './types.js'

const databases: ReturnType<typeof openDatabase>[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
})

function createGame(specials: SpecialType[] = []) {
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
      specials,
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
  it('assigns each enabled special once to a distinct ordinary clue', () => {
    const game = createGame(['double_points', 'speed_round'])
    const room = game.engine.startGame(game.room)

    expect(Object.keys(room.state.specialAssignments ?? {})).toHaveLength(2)
    expect(new Set(Object.values(room.state.specialAssignments ?? {}))).toEqual(
      new Set(['double_points', 'speed_round']),
    )
    expect(Object.keys(room.state.specialAssignments ?? {})).toEqual(
      expect.arrayContaining(game.clueIds),
    )
    expect(game.engine.publicSnapshot(room).activeClue).toBeUndefined()
  })

  it('rejects more specials than eligible ordinary clues', () => {
    expect(() =>
      createGame(['double_points', 'double_or_nothing', 'speed_round']),
    ).toThrow('at least 3 ordinary clues')
  })

  it('never assigns a special to the Final Question', () => {
    const game = createGame(['double_points'])
    game.database
      .prepare('UPDATE clues SET is_final = 1 WHERE id = ?')
      .run(game.clueIds[0])

    const room = game.engine.startGame(game.room)

    expect(room.state.specialAssignments).toEqual({
      [game.clueIds[1] ?? '']: 'double_points',
    })
  })

  it('requires at least two players when Forced Player is enabled', () => {
    const game = createGame(['forced_player'])
    game.rooms.kickPlayer(game.room.id, game.playerTwo.id)

    expect(() => game.engine.startGame(game.room)).toThrow(
      'Forced Player requires at least two players',
    )
  })

  it('doubles positive music points without penalizing incorrect answers', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'double_points' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')

    expect(game.engine.publicSnapshot(room).activeClue).toMatchObject({
      special: 'double_points',
    })
    game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    game.engine.submitAnswer(room, game.playerTwo.id, 'Wrong')
    room = game.engine.closeAnswers(room)

    const scores = game.rooms.scores(room.id)
    expect(scores.find(({ playerId }) => playerId === game.playerOne.id)?.score).toBeGreaterThan(200)
    expect(scores.find(({ playerId }) => playerId === game.playerOne.id)?.score).toBeLessThanOrEqual(400)
    expect(scores.find(({ playerId }) => playerId === game.playerTwo.id)?.score).toBe(0)
  })

  it('applies Double or Nothing wins and missing-answer penalties', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[1] ?? '']: 'double_or_nothing' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[1] ?? '')
    game.engine.submitAnswer(room, game.playerOne.id, 90)
    room = game.engine.closeAnswers(room)

    expect(game.rooms.scores(room.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: game.playerOne.id, score: 720 }),
        expect.objectContaining({ playerId: game.playerTwo.id, score: -400 }),
      ]),
    )
    room = game.engine.reveal(room)
    expect(game.engine.publicSnapshot(room).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: game.playerOne.id, correct: 1 }),
        expect.objectContaining({ playerId: game.playerTwo.id, pointsAwarded: -400 }),
      ]),
    )
  })

  it('halves a Speed Round timer and preserves it through reset and Go Back', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'speed_round' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    expect(game.engine.publicSnapshot(room).activeClue?.timerSeconds).toBe(15)
    expect(Date.parse(room.state.deadline ?? '') - Date.parse(room.state.startedAt ?? '')).toBe(15_000)

    room = game.engine.resetClue(room)
    expect(Date.parse(room.state.deadline ?? '') - Date.parse(room.state.startedAt ?? '')).toBe(15_000)
    room = game.engine.goBack(room)
    expect(room.state.specialAssignments?.[game.clueIds[0] ?? '']).toBe('speed_round')
  })

  it('keeps assigned specials attached while reversing special scores on Go Back', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'double_or_nothing' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    game.engine.submitAnswer(room, game.playerOne.id, 'Wrong')
    room = game.engine.closeAnswers(room)
    expect(game.rooms.scores(room.id).every(({ score }) => score === -200)).toBe(true)

    room = game.engine.goBack(room)
    expect(game.rooms.scores(room.id).every(({ score }) => score === 0)).toBe(true)
    expect(room.state.specialAssignments?.[game.clueIds[0] ?? '']).toBe('double_or_nothing')
  })

  it('collects Forced Player votes and restricts answering to the selected player', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')

    expect(room.state.phase).toBe('SPECIAL_VOTE')
    expect(game.engine.publicSnapshot(room).activeClue?.prompt).toBe(
      'Vote for the player who must answer this clue.',
    )
    expect(() =>
      game.engine.submitSpecialVote(room, game.playerOne.id, game.playerOne.id),
    ).toThrow('cannot vote for yourself')

    room = game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id)
    expect(() =>
      game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id),
    ).toThrow('already locked')
    room = game.engine.resolveSpecialVote(room)

    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect(room.state.forcedPlayerId).toBe(game.playerTwo.id)
    expect(() =>
      game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen'),
    ).toThrow('Only the selected player')
  })

  it('opens the clue automatically after every player votes', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    room = game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id)
    room = game.engine.submitSpecialVote(room, game.playerTwo.id, game.playerOne.id)

    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect([game.playerOne.id, game.playerTwo.id]).toContain(room.state.forcedPlayerId)
  })

  it('hides clue content during Forced Player voting and ignores kicked-player votes', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    expect(game.engine.publicSnapshot(room).activeClue).toMatchObject({
      prompt: 'Vote for the player who must answer this clue.',
      mediaUrl: undefined,
    })
    room = game.engine.pause(room)
    expect(game.engine.publicSnapshot(room).activeClue).toMatchObject({
      prompt: 'Vote for the player who must answer this clue.',
      mediaUrl: undefined,
    })
    room = game.engine.resume(room)
    room = game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id)
    game.rooms.kickPlayer(room.id, game.playerTwo.id)

    expect(game.engine.publicSnapshot(room).specialVotedPlayerIds).toEqual([])
    room = game.engine.resolveSpecialVote(room)
    expect(room.state.forcedPlayerId).toBe(game.playerOne.id)
  })

  it('selects the sole remaining player if the voting roster shrinks to one', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    game.rooms.kickPlayer(room.id, game.playerTwo.id)

    room = game.engine.resolveSpecialVote(room)

    expect(room.state).toMatchObject({
      phase: 'ACCEPTING_ANSWERS',
      forcedPlayerId: game.playerOne.id,
    })
  })

  it('lets players replace votes whose target was kicked', () => {
    const game = createGame()
    const playerThree = game.rooms.join(game.room, 'Jordan').player
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    room = game.engine.submitSpecialVote(room, game.playerOne.id, playerThree.id)
    room = game.engine.submitSpecialVote(room, game.playerTwo.id, playerThree.id)
    game.rooms.kickPlayer(room.id, playerThree.id)

    room = game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id)
    room = game.engine.submitSpecialVote(room, game.playerTwo.id, game.playerOne.id)

    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect([game.playerOne.id, game.playerTwo.id]).toContain(room.state.forcedPlayerId)
  })

  it('awards the full clue value when the forced player answers correctly', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    room = game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id)
    room = game.engine.resolveSpecialVote(room)
    game.engine.submitAnswer(room, game.playerTwo.id, 'Dancing Queen')
    room = game.engine.closeAnswers(room)

    expect(game.rooms.scores(room.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: game.playerOne.id, score: 0 }),
        expect.objectContaining({ playerId: game.playerTwo.id, score: 200 }),
      ]),
    )
  })

  it('awards everyone else when the forced player answers incorrectly or not at all', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[0] ?? '')
    room = game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id)
    room = game.engine.resolveSpecialVote(room)
    game.engine.submitAnswer(room, game.playerTwo.id, 'Wrong')
    room = game.engine.closeAnswers(room)

    expect(game.rooms.scores(room.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: game.playerOne.id, score: 200 }),
        expect.objectContaining({ playerId: game.playerTwo.id, score: 0 }),
      ]),
    )
    room = game.engine.resetClue(room)
    expect(room.state).toMatchObject({
      phase: 'SPECIAL_VOTE',
      specialVotes: {},
    })
    expect(room.state.forcedPlayerId).toBeUndefined()
    expect(game.rooms.scores(room.id).every(({ score }) => score === 0)).toBe(true)
  })

  it('requires an exact price guess from the forced player', () => {
    const game = createGame()
    let room = game.engine.startGame(game.room)
    room = game.rooms.saveState(
      room.id,
      {
        ...room.state,
        specialAssignments: { [game.clueIds[1] ?? '']: 'forced_player' },
      },
      room.status,
      room.stateVersion,
    )
    room = game.engine.selectClue(room, game.clueIds[1] ?? '')
    room = game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id)
    room = game.engine.resolveSpecialVote(room)
    game.engine.submitAnswer(room, game.playerTwo.id, 90)
    room = game.engine.closeAnswers(room)

    expect(game.rooms.scores(room.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: game.playerOne.id, score: 400 }),
        expect.objectContaining({ playerId: game.playerTwo.id, score: 0 }),
      ]),
    )
  })

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
