import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../database.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { GameEngine } from './engine.js'
import type { SpecialType } from './types.js'
const databases: ReturnType<typeof openDatabase>[] = []
afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
})
async function createGame(specials: SpecialType[] = []) {
  const database = openDatabase(':memory:')
  databases.push(database)
  const packs = new PackRepository(database)
  const rooms = new RoomRepository(database)
  const engine = new GameEngine(database, rooms, 'http://192.168.1.10:3000')
  const pack = (await packs.create({ title: 'Party' })) as {
    id: string
  }
  database
    .prepare(`INSERT INTO media_assets
       (id, relative_path, original_name, mime_type, size_bytes)
       VALUES ('test-media', 'songs/test.mp3', 'test.mp3', 'audio/mpeg', 1)`)
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
              mediaPlayback: { delaySeconds: 2, playCount: 3 },
              revealMediaPlayback: { delaySeconds: 1, playCount: 1 },
              correctAnswer: 'Dancing Queen',
              questionGif: { provider: 'url', url: 'https://example.com/question.gif',
                previewUrl: 'https://example.com/question.gif', sourceUrl: 'https://example.com/question.gif', alt: 'Question picture' },
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
  const savedPack = (await packs.replace(pack.id, packInput)) as {
    categories: Array<{
      clues: Array<{
        id: string
      }>
    }>
  }
  const created = (await rooms.create(pack.id, {
    timerSeconds: 30,
    speedBonusMax: 100,
    priceRankPercentages: [1, 0.5],
    uniqueNicknames: true,
    specials,
  }, 4))
  const playerOne = (await rooms.join(created.room, 'Alex'))
  const playerTwo = (await rooms.join(created.room, 'Sam'))
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
  it('builds paired snapshots once without exposing host configuration or unrevealed answers', async () => {
    const game = await createGame()
    let room = await game.engine.startGame(game.room)
    room = await game.engine.selectClue(room, game.clueIds[0]!)
    const clues = vi.spyOn(game.rooms.store, 'clue')
    const pair = await game.engine.snapshotPair(room)
    // SQLite's receipt query also looks up its clue.
    expect(clues).toHaveBeenCalledTimes(2)
    expect(pair.public.activeClue).not.toHaveProperty('config')
    expect(pair.public.activeClue?.answer).toBeUndefined()
    expect(pair.public.activeClue?.mediaPlayback).toEqual({ delaySeconds: 2, playCount: 3 })
    expect(pair.public.activeClue?.revealMediaPlayback).toEqual({ delaySeconds: 1, playCount: 1 })
    expect(pair.host?.activeClue?.config).toMatchObject({ correctAnswer: 'Dancing Queen' })
    const publicSnapshot = await game.engine.publicSnapshot(room)
    const hostSnapshot = await game.engine.hostSnapshot(room)
    expect({ ...pair.public, snapshotSequence: 0 }).toEqual({ ...publicSnapshot, snapshotSequence: 0 })
    expect({ ...pair.host, snapshotSequence: 0 }).toEqual({ ...hostSnapshot, snapshotSequence: 0 })
    clues.mockRestore()
    game.engine.dispose()
  })
  it('counts disconnected seats, ignores duplicates and kicked answers, and clears progress on reset', async () => {
    const game = await createGame()
    let room = await game.engine.startGame(game.room)
    room = await game.engine.selectClue(room, game.clueIds[0]!)
    await game.rooms.setConnected(game.playerTwo.id, false)
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    await expect(game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')).rejects.toThrow()
    const reads = vi.spyOn(game.rooms.store, 'submissions')
    const pair = await game.engine.snapshotPair(room)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(pair.public.answerProgress).toEqual({ answered: 1, total: 2 })
    expect(pair.public).not.toHaveProperty('submissions')
    expect(pair.host?.submissions).toHaveLength(1)
    await game.engine.submitAnswer(room, game.playerTwo.id, 'Dancing Queen')
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 2, total: 2 })
    room = await game.engine.pause(room)
    expect((await game.engine.publicSnapshot(room)).answerProgress).toBeUndefined()
    room = await game.engine.resume(room)
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 2, total: 2 })
    await game.rooms.kickPlayer(room.id, game.playerOne.id)
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 1, total: 1 })
    room = await game.engine.resetClue(room)
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 0, total: 1 })
    await game.rooms.kickPlayer(room.id, game.playerTwo.id)
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 0, total: 0 })
    game.engine.dispose()
  })
  it('settles all 50 active price answers and reverses only game awards on reset', async () => {
    const game = await createGame()
    for (let index = 0; index < 48; index++) await game.rooms.join(game.room, `Player ${index}`)
    let room = await game.engine.startGame(game.room)
    room = await game.engine.selectClue(room, game.clueIds[1]!)
    await game.engine.adjustScore(room, game.playerOne.id, 25, 'Manual correction')
    for (const player of await game.rooms.listPlayers(room.id)) await game.engine.submitAnswer(room, player.id, 100)
    room = await game.engine.closeAnswers(room)
    expect((await game.rooms.scores(room.id)).find(({ playerId }) => playerId === game.playerOne.id)?.score).toBe(425)
    expect(game.database.prepare('SELECT COUNT(*) AS count FROM result_chunks').get()).toEqual({ count: 0 })
    room = await game.engine.resetClue(room)
    expect((await game.rooms.scores(room.id)).find(({ playerId }) => playerId === game.playerOne.id)?.score).toBe(25)
    expect((await game.rooms.scores(room.id)).filter(({ score }) => score === 0)).toHaveLength(49)
    game.engine.dispose()
  })
  it('allows more than 50 lifetime players/answers, stages scoring, and reverses kicked awards', async () => {
    const game = await createGame()
    let room = await game.engine.startGame(game.room)
    room = await game.engine.selectClue(room, game.clueIds[1]!)
    for (let index = 0; index < 105; index++) {
      const joined = await game.rooms.join(room, `Replacement ${index}`)
      await game.engine.submitAnswer(room, joined.player.id, 100)
      await game.rooms.kickPlayer(room.id, joined.player.id)
    }
    await game.engine.submitAnswer(room, game.playerOne.id, 100)
    room = await game.engine.closeAnswers(room)
    expect((await game.rooms.scores(room.id)).find(({ playerId }) => playerId === game.playerOne.id)?.score).toBe(400)
    expect(game.database.prepare('SELECT COUNT(*) AS count FROM result_chunks').get()).toEqual({ count: 3 })
    expect(game.database.prepare('SELECT COUNT(*) AS count FROM submissions').get()).toEqual({ count: 106 })
    room = await game.engine.resetClue(room)
    expect(game.database.prepare('SELECT SUM(delta) AS score FROM score_events').get()).toEqual({ score: 0 })
    expect(await game.rooms.listPlayers(room.id)).toHaveLength(2)
    game.engine.dispose()
  })
  it('assigns each enabled special once to a distinct ordinary clue', async () => {
    const game = (await createGame(['double_points', 'speed_round']))
    const room = (await game.engine.startGame(game.room))
    expect(Object.keys(room.state.specialAssignments ?? {})).toHaveLength(2)
    expect(new Set(Object.values(room.state.specialAssignments ?? {}))).toEqual(new Set(['double_points', 'speed_round']))
    expect(Object.keys(room.state.specialAssignments ?? {})).toEqual(expect.arrayContaining(game.clueIds))
    expect((await game.engine.publicSnapshot(room)).activeClue).toBeUndefined()
  })
  it('rejects more specials than eligible ordinary clues', async () => {
    await expect(createGame(['double_points', 'double_or_nothing', 'speed_round'])).rejects.toThrow('at least 3 ordinary clues')
  })
  it('never assigns a special to the Final Question', async () => {
    const game = (await createGame(['double_points']))
    game.database
      .prepare('UPDATE clues SET is_final = 1 WHERE id = ?')
      .run(game.clueIds[0])
    const room = (await game.engine.startGame(game.room))
    expect(room.state.specialAssignments).toEqual({
      [game.clueIds[1] ?? '']: 'double_points',
    })
  })
  it('requires at least two players when Forced Player is enabled', async () => {
    const game = (await createGame(['forced_player']))
    await game.rooms.kickPlayer(game.room.id, game.playerTwo.id)
    await expect(game.engine.startGame(game.room)).rejects.toThrow('Forced Player requires at least two players')
  })
  it('doubles positive music points without penalizing incorrect answers', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'double_points' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect((await game.engine.publicSnapshot(room)).activeClue).toMatchObject({
      special: 'double_points',
    })
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    await game.engine.submitAnswer(room, game.playerTwo.id, 'Wrong')
    room = (await game.engine.closeAnswers(room))
    const scores = (await game.rooms.scores(room.id))
    expect(scores.find(({ playerId }) => playerId === game.playerOne.id)?.score).toBeGreaterThan(200)
    expect(scores.find(({ playerId }) => playerId === game.playerOne.id)?.score).toBeLessThanOrEqual(400)
    expect(scores.find(({ playerId }) => playerId === game.playerTwo.id)?.score).toBe(0)
  })
  it('applies Double or Nothing wins and missing-answer penalties', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[1] ?? '']: 'double_or_nothing' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[1] ?? ''))
    await game.engine.submitAnswer(room, game.playerOne.id, 90)
    room = (await game.engine.closeAnswers(room))
    expect((await game.rooms.scores(room.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: game.playerOne.id, score: 720 }),
      expect.objectContaining({ playerId: game.playerTwo.id, score: -400 }),
    ]))
    room = (await game.engine.reveal(room))
    expect((await game.engine.publicSnapshot(room)).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: game.playerOne.id, correct: 1 }),
      expect.objectContaining({ playerId: game.playerTwo.id, pointsAwarded: -400 }),
    ]))
  })
  it('halves a Speed Round timer and preserves it through reset and Go Back', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'speed_round' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect((await game.engine.publicSnapshot(room)).activeClue?.timerSeconds).toBe(15)
    expect(Date.parse(room.state.deadline ?? '') - Date.parse(room.state.startedAt ?? '')).toBe(15000)
    room = (await game.engine.resetClue(room))
    expect(Date.parse(room.state.deadline ?? '') - Date.parse(room.state.startedAt ?? '')).toBe(15000)
    room = (await game.engine.goBack(room))
    expect(room.state.specialAssignments?.[game.clueIds[0] ?? '']).toBe('speed_round')
  })
  it('keeps assigned specials attached while reversing special scores on Go Back', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'double_or_nothing' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    await game.engine.submitAnswer(room, game.playerOne.id, 'Wrong')
    room = (await game.engine.closeAnswers(room))
    expect((await game.rooms.scores(room.id)).every(({ score }) => score === -200)).toBe(true)
    room = (await game.engine.goBack(room))
    expect((await game.rooms.scores(room.id)).every(({ score }) => score === 0)).toBe(true)
    expect(room.state.specialAssignments?.[game.clueIds[0] ?? '']).toBe('double_or_nothing')
  })
  it('collects Forced Player votes and restricts answering to the selected player', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect(room.state.phase).toBe('SPECIAL_VOTE')
    expect((await game.engine.publicSnapshot(room)).activeClue?.prompt).toBe('Vote for the player who must answer this clue.')
    expect((await game.engine.publicSnapshot(room)).activeClue?.questionGif).toBeUndefined()
    await expect(game.engine.submitSpecialVote(room, game.playerOne.id, game.playerOne.id)).rejects.toThrow('cannot vote for yourself')
    room = (await game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id))
    await expect(game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id)).rejects.toThrow('already locked')
    room = (await game.engine.resolveSpecialVote(room))
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect(room.state.forcedPlayerId).toBe(game.playerTwo.id)
    expect((await game.engine.publicSnapshot(room)).activeClue?.questionGif?.alt).toBe('Question picture')
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 0, total: 1 })
    await expect(game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')).rejects.toThrow('Only the selected player')
    await game.engine.submitAnswer(room, game.playerTwo.id, 'Dancing Queen')
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 1, total: 1 })
  })
  it('opens the clue automatically after every player votes', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    room = (await game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id))
    room = (await game.engine.submitSpecialVote(room, game.playerTwo.id, game.playerOne.id))
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect([game.playerOne.id, game.playerTwo.id]).toContain(room.state.forcedPlayerId)
  })
  it('hides clue content during Forced Player voting and ignores kicked-player votes', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect((await game.engine.publicSnapshot(room)).activeClue).toMatchObject({
      prompt: 'Vote for the player who must answer this clue.',
      mediaUrl: undefined,
    })
    room = (await game.engine.pause(room))
    expect((await game.engine.publicSnapshot(room)).activeClue).toMatchObject({
      prompt: 'Vote for the player who must answer this clue.',
      mediaUrl: undefined,
    })
    room = (await game.engine.resume(room))
    room = (await game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id))
    await game.rooms.kickPlayer(room.id, game.playerTwo.id)
    expect((await game.engine.publicSnapshot(room)).specialVotedPlayerIds).toEqual([])
    room = (await game.engine.resolveSpecialVote(room))
    expect(room.state.forcedPlayerId).toBe(game.playerOne.id)
  })
  it('selects the sole remaining player if the voting roster shrinks to one', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    await game.rooms.kickPlayer(room.id, game.playerTwo.id)
    room = (await game.engine.resolveSpecialVote(room))
    expect(room.state).toMatchObject({
      phase: 'ACCEPTING_ANSWERS',
      forcedPlayerId: game.playerOne.id,
    })
  })
  it('lets players replace votes whose target was kicked', async () => {
    const game = (await createGame())
    const playerThree = (await game.rooms.join(game.room, 'Jordan')).player
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    room = (await game.engine.submitSpecialVote(room, game.playerOne.id, playerThree.id))
    room = (await game.engine.submitSpecialVote(room, game.playerTwo.id, playerThree.id))
    await game.rooms.kickPlayer(room.id, playerThree.id)
    room = (await game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id))
    room = (await game.engine.submitSpecialVote(room, game.playerTwo.id, game.playerOne.id))
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect([game.playerOne.id, game.playerTwo.id]).toContain(room.state.forcedPlayerId)
  })
  it('awards the full clue value when the forced player answers correctly', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    room = (await game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id))
    room = (await game.engine.resolveSpecialVote(room))
    await game.engine.submitAnswer(room, game.playerTwo.id, 'Dancing Queen')
    room = (await game.engine.closeAnswers(room))
    expect((await game.rooms.scores(room.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: game.playerOne.id, score: 0 }),
      expect.objectContaining({ playerId: game.playerTwo.id, score: 200 }),
    ]))
  })
  it('awards everyone else when the forced player answers incorrectly or not at all', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[0] ?? '']: 'forced_player' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    room = (await game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id))
    room = (await game.engine.resolveSpecialVote(room))
    await game.engine.submitAnswer(room, game.playerTwo.id, 'Wrong')
    room = (await game.engine.closeAnswers(room))
    expect((await game.rooms.scores(room.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: game.playerOne.id, score: 200 }),
      expect.objectContaining({ playerId: game.playerTwo.id, score: 0 }),
    ]))
    room = (await game.engine.resetClue(room))
    expect(room.state).toMatchObject({
      phase: 'SPECIAL_VOTE',
      specialVotes: {},
    })
    expect(room.state.forcedPlayerId).toBeUndefined()
    expect((await game.rooms.scores(room.id)).every(({ score }) => score === 0)).toBe(true)
  })
  it('requires an exact price guess from the forced player', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.rooms.saveState(room.id, {
      ...room.state,
      specialAssignments: { [game.clueIds[1] ?? '']: 'forced_player' },
    }, room.status, room.stateVersion))
    room = (await game.engine.selectClue(room, game.clueIds[1] ?? ''))
    room = (await game.engine.submitSpecialVote(room, game.playerOne.id, game.playerTwo.id))
    room = (await game.engine.resolveSpecialVote(room))
    await game.engine.submitAnswer(room, game.playerTwo.id, 90)
    room = (await game.engine.closeAnswers(room))
    expect((await game.rooms.scores(room.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: game.playerOne.id, score: 400 }),
      expect.objectContaining({ playerId: game.playerTwo.id, score: 0 }),
    ]))
  })
  it('publishes a LAN-safe player join URL', async () => {
    const game = (await createGame())
    expect((await game.engine.publicSnapshot(game.room)).joinUrl).toBe(`http://192.168.1.10:3000/play/${game.room.code}`)
  })
  it('publishes the configured answer reveal audio', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect((await game.engine.publicSnapshot(room)).activeClue).toMatchObject({
      mediaUrl: '/api/media/test-media/stream',
      revealMediaUrl: '/api/media/test-media/stream',
    })
  })
  it('publishes independent question and reveal GIFs only in their authorized stages', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect((await game.engine.publicSnapshot(room)).activeClue?.revealGif).toBeUndefined()
    expect((await game.engine.publicSnapshot(room)).activeClue?.questionGif?.alt).toBe('Question picture')
    room = await game.engine.pause(room)
    expect((await game.engine.publicSnapshot(room)).activeClue?.questionGif?.alt).toBe('Question picture')
    room = await game.engine.resume(room)
    room = (await game.engine.closeAnswers(room))
    expect((await game.engine.publicSnapshot(room)).activeClue?.questionGif?.alt).toBe('Question picture')
    room = (await game.engine.reveal(room))
    expect((await game.engine.publicSnapshot(room)).activeClue?.questionGif).toBeUndefined()
    expect((await game.engine.publicSnapshot(room)).activeClue?.revealGif).toMatchObject({
      provider: 'giphy',
      alt: 'Celebration',
    })
  })
  it('runs a music clue and records score events once', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect(room.state.deadline).toBeDefined()
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen!')
    await game.engine.submitAnswer(room, game.playerTwo.id, 'Wrong song')
    room = (await game.engine.closeAnswers(room))
    const scores = (await game.rooms.scores(room.id))
    expect(scores.find((score) => score.playerId === game.playerOne.id)?.score).toBeLessThanOrEqual(200)
    expect(scores.find((score) => score.playerId === game.playerOne.id)?.score).toBeGreaterThan(0)
    expect(scores.find((score) => score.playerId === game.playerTwo.id)?.score).toBe(0)
    await expect(game.engine.closeAnswers(room)).rejects.toThrow('Answers are not open')
    const edited = structuredClone(game.packInput)
    const originalPrompt = edited.categories[0]?.clues[0]?.prompt
    if (edited.categories[0]?.clues[0])
      edited.categories[0].clues[0].prompt = 'Edited prompt'
    await expect(game.packs.replace(game.pack.id, edited)).resolves.toBeDefined()
    const historical = game.database
      .prepare('SELECT clue_prompt AS prompt FROM submissions WHERE room_id = ?')
      .get(room.id) as {
        prompt: string
      }
    expect(historical.prompt).toBe(originalPrompt)
  })
  it('ranks price guesses without rewarding overbids', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[1] ?? ''))
    await game.engine.submitAnswer(room, game.playerOne.id, 90)
    await game.engine.submitAnswer(room, game.playerTwo.id, 101)
    room = (await game.engine.closeAnswers(room))
    room = (await game.engine.reveal(room))
    const scores = (await game.rooms.scores(room.id))
    expect(scores.find((score) => score.playerId === game.playerOne.id)?.score).toBe(360)
    expect(scores.find((score) => score.playerId === game.playerTwo.id)?.score).toBe(0)
    expect((await game.engine.publicSnapshot(room)).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: game.playerOne.id, pointsAwarded: 360 }),
      expect.objectContaining({ playerId: game.playerTwo.id, pointsAwarded: 0 }),
    ]))
  })
  it('limits answer submission updates to the authenticated host channel', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    let roomUpdates = 0
    let hostUpdates = 0
    game.engine.on('roomUpdated', () => {
      roomUpdates += 1
    })
    game.engine.on('hostUpdated', () => {
      hostUpdates += 1
    })
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    expect(hostUpdates).toBe(1)
    expect(roomUpdates).toBe(0)
  })
  it('preserves active answer time across a pause', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    room = (await game.engine.pause(room))
    room = (await game.engine.resume(room))
    const resumedAt = Date.parse(room.state.startedAt ?? '')
    expect(Date.now() - resumedAt).toBeLessThan(1000)
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    room = (await game.engine.closeAnswers(room))
    expect((await game.rooms.scores(room.id))[0]?.score).toBeLessThanOrEqual(200)
    expect((await game.rooms.scores(room.id))[0]?.score).toBeGreaterThan(0)
  })
  it('keeps the last ordinary clue playable when no Final Question is configured', async () => {
    const game = (await createGame())
    game.database
      .prepare('UPDATE clues SET archived = 1 WHERE id = ?')
      .run(game.clueIds[1])
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect((await game.engine.publicSnapshot(room)).hasFinalQuestion).toBe(false)
  })
  it('returns a clue to the board as unplayed and removes its answers and score', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    room = (await game.engine.closeAnswers(room))
    expect((await game.rooms.scores(room.id))[0]?.score).toBeGreaterThan(0)
    room = (await game.engine.goBack(room))
    expect(room.state.phase).toBe('BOARD')
    expect(room.state.activeClueId).toBeUndefined()
    expect(room.state.usedClueIds).not.toContain(game.clueIds[0])
    expect((await game.rooms.scores(room.id))[0]?.score).toBe(0)
    expect(game.database.prepare('SELECT COUNT(*) AS count FROM submissions WHERE room_id = ?').get(room.id)).toEqual({ count: 0 })
    await expect(game.engine.selectClue(room, game.clueIds[0] ?? '')).resolves.toBeDefined()
  })
  it('resets the current clue with a fresh timer and empty answers', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    room = (await game.engine.closeAnswers(room))
    room = (await game.engine.resetClue(room))
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    expect(room.state.deadline).toBeDefined()
    expect((await game.rooms.scores(room.id))[0]?.score).toBe(0)
    expect(game.database.prepare('SELECT COUNT(*) AS count FROM submissions WHERE room_id = ?').get(room.id)).toEqual({ count: 0 })
    await expect(game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')).resolves.toBeDefined()
  })
  it('finishes when the final question is skipped', async () => {
    const game = (await createGame())
    game.database
      .prepare('UPDATE clues SET archived = 1 WHERE id = ?')
      .run(game.clueIds[1])
    game.database
      .prepare('UPDATE clues SET is_final = 1 WHERE id = ?')
      .run(game.clueIds[0])
    let room = (await game.engine.startGame(game.room))
    expect((await game.engine.publicSnapshot(room))).toMatchObject({
      board: [],
      hasFinalQuestion: true,
    })
    room = (await game.engine.startFinalRound(room))
    await game.engine.submitFinalWager(room, game.playerOne.id, 0)
    await game.engine.submitFinalWager(room, game.playerTwo.id, 0)
    room = (await game.engine.startFinalQuestion(room))
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 0, total: 2 })
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    await game.engine.submitAnswer(room, game.playerTwo.id, 'Dancing Queen')
    expect((await game.engine.publicSnapshot(room)).answerProgress).toEqual({ answered: 2, total: 2 })
    room = (await game.engine.skipClue(room))
    expect(room.state.phase).toBe('FINISHED')
    expect(room.status).toBe('finished')
  })
  it('requires wagers and awards the fixed wager for the final question', async () => {
    const game = (await createGame())
    game.database
      .prepare('UPDATE clues SET is_final = 1 WHERE id = ?')
      .run(game.clueIds[0])
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[1] ?? ''))
    await game.engine.submitAnswer(room, game.playerOne.id, 90)
    await game.engine.submitAnswer(room, game.playerTwo.id, 101)
    room = (await game.engine.closeAnswers(room))
    room = (await game.engine.reveal(room))
    room = (await game.engine.showLeaderboard(room))
    await game.engine.adjustScore(room, game.playerTwo.id, 50, 'Final wager seed')
    await expect(game.engine.selectClue(room, game.clueIds[0] ?? '')).rejects.toThrow('Final Question control')
    room = (await game.engine.startFinalRound(room))
    await game.engine.submitFinalWager(room, game.playerOne.id, 100)
    await expect(game.engine.startFinalQuestion(room)).rejects.toThrow('Every player')
    await expect(game.engine.submitFinalWager(room, game.playerTwo.id, 51)).rejects.toThrow('0 to 50')
    await game.engine.submitFinalWager(room, game.playerTwo.id, 50)
    room = (await game.engine.startFinalQuestion(room))
    await game.engine.submitAnswer(room, game.playerOne.id, 'Dancing Queen')
    await game.engine.submitAnswer(room, game.playerTwo.id, 'Wrong')
    game.database
      .prepare('UPDATE submissions SET elapsed_ms = 29999 WHERE room_id = ? AND player_id = ?')
      .run(room.id, game.playerOne.id)
    room = (await game.engine.closeAnswers(room))
    room = (await game.engine.reveal(room))
    expect((await game.engine.publicSnapshot(room)).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: game.playerOne.id, pointsAwarded: 100 }),
      expect.objectContaining({ playerId: game.playerTwo.id, pointsAwarded: -50 }),
    ]))
    expect((await game.rooms.scores(room.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: game.playerOne.id, score: 460 }),
      expect.objectContaining({ playerId: game.playerTwo.id, score: 0 }),
    ]))
  })
  it('allows the host to start a configured Final Question before board clues are complete', async () => {
    const game = (await createGame())
    game.database
      .prepare('UPDATE clues SET is_final = 1 WHERE id = ?')
      .run(game.clueIds[0])
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.startFinalRound(room))
    expect(room.state.phase).toBe('FINAL_WAGER')
    expect(room.state.activeClueId).toBe(game.clueIds[0])
    expect((await game.engine.publicSnapshot(room)).board).toHaveLength(1)
    expect((await game.engine.publicSnapshot(room)).activeClue).toBeUndefined()
    await game.engine.submitFinalWager(room, game.playerOne.id, 0)
    await game.engine.submitFinalWager(room, game.playerTwo.id, 0)
    room = await game.engine.startFinalQuestion(room)
    expect((await game.engine.publicSnapshot(room)).activeClue?.questionGif?.alt).toBe('Question picture')
  })
  it('closes an answer round whose recovered timer already expired', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    room = (await game.engine.pause(room))
    room = (await game.rooms.saveState(room.id, { ...room.state, remainingMs: 0 }, 'paused', room.stateVersion))
    room = (await game.engine.resume(room))
    expect(room.state.phase).toBe('ANSWERS_CLOSED')
  })
  it('ends and abandons a live session from any game phase', async () => {
    const game = (await createGame())
    let room = (await game.engine.startGame(game.room))
    room = (await game.engine.selectClue(room, game.clueIds[0] ?? ''))
    expect(room.state.phase).toBe('ACCEPTING_ANSWERS')
    room = (await game.engine.endSession(room))
    expect(room.state.phase).toBe('FINISHED')
    expect(room.state.activeClueId).toBeUndefined()
    expect(room.status).toBe('abandoned')
    expect(room.completedAt).not.toBeNull()
  })
})
