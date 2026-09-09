import { afterEach, describe, expect, it } from 'vitest'

import { resolveContentPath } from './content.js'
import { openDatabase } from './database.js'
import { PackRepository } from './repositories/packs.js'
import { RoomRepository } from './repositories/rooms.js'

const databases: ReturnType<typeof openDatabase>[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
})

describe('database', () => {
  it('applies migrations idempotently', () => {
    const database = openDatabase(':memory:')
    databases.push(database)

    expect(database.pragma('user_version', { simple: true })).toBe(8)
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rooms'")
        .get(),
    ).toBeDefined()
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'final_wagers'")
        .get(),
    ).toBeDefined()
  })

  it('creates a pack and collision-resistant room credentials', () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const packs = new PackRepository(database)
    const rooms = new RoomRepository(database)
    const pack = packs.create({ title: 'Party' }) as { id: string }
    packs.replace(pack.id, {
      title: 'Party',
      status: 'ready',
      categories: [
        {
          title: 'Prices',
          clues: [
            {
              type: 'price_slider',
              boardValue: 100,
              prompt: 'Guess the price',
              config: { correctPrice: 50, min: 0, max: 100 },
            },
          ],
        },
      ],
    })

    const created = rooms.create(
      pack.id,
      {
        timerSeconds: 30,
        speedBonusMax: 500,
        priceRankPercentages: [1, 0.75],
        uniqueNicknames: true,
      },
      4,
    )

    expect(created.room.code).toMatch(/^[A-Z2-9]{4}$/)
    expect(created.hostToken).not.toBe(created.room.hostTokenHash)
    expect(rooms.isHost(created.room, created.hostToken)).toBe(true)
    for (let index = 1; index <= 50; index += 1) {
      rooms.join(created.room, `Player ${index}`)
    }
    expect(rooms.listPlayers(created.room.id)).toHaveLength(50)
    expect(() => rooms.join(created.room, 'Player 51')).toThrow('This room is full')
  })

  it('persists team membership and derives team contributions from player scores', () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const packs = new PackRepository(database)
    const rooms = new RoomRepository(database)
    const pack = packs.create({ title: 'Teams' }) as { id: string }
    packs.replace(pack.id, {
      title: 'Teams',
      status: 'ready',
      categories: [
        {
          title: 'Prices',
          clues: [
            {
              type: 'price_slider',
              boardValue: 100,
              prompt: 'Guess',
              config: { correctPrice: 50, min: 0, max: 100 },
            },
          ],
        },
      ],
    })
    const created = rooms.create(
      pack.id,
      {
        timerSeconds: 30,
        speedBonusMax: 500,
        priceRankPercentages: [1],
        uniqueNicknames: true,
        teams: ['Red', 'Blue'],
      },
      4,
    )

    expect(() => rooms.join(created.room, 'No Team')).toThrow('Choose a valid team')
    expect(() => rooms.join(created.room, 'Bad Team', 'Green')).toThrow('Choose a valid team')

    const redOne = rooms.join(created.room, 'Alex', 'red')
    const redTwo = rooms.join(created.room, 'Sam', 'Red')
    const blue = rooms.join(created.room, 'Jamie', 'Blue')
    expect(redOne.player.teamName).toBe('Red')
    expect(rooms.reconnect(created.room, redOne.player.id, redOne.reconnectToken)?.teamName).toBe(
      'Red',
    )

    const score = database.prepare(
      `INSERT INTO score_events
       (id, room_id, player_id, delta, source, reason, actor)
       VALUES (?, ?, ?, ?, 'host_adjustment', 'test', 'host')`,
    )
    score.run('score-red-1', created.room.id, redOne.player.id, 100)
    score.run('score-red-2', created.room.id, redTwo.player.id, 50)
    score.run('score-blue', created.room.id, blue.player.id, 125)

    const scores = rooms.scores(created.room.id)
    expect(scores.find((player) => player.playerId === redOne.player.id)).toMatchObject({
      teamName: 'Red',
      score: 100,
    })
    const teamTotals = scores.reduce<Record<string, number>>((totals, player) => {
      totals[player.teamName ?? ''] = (totals[player.teamName ?? ''] ?? 0) + player.score
      return totals
    }, {})
    expect(teamTotals).toEqual({ Blue: 125, Red: 150 })
  })

  it('persists at most one explicitly designated Final Question per pack', () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const packs = new PackRepository(database)
    const pack = packs.create({ title: 'Finals' }) as { id: string }
    const clue = {
      type: 'price_slider',
      boardValue: 100,
      prompt: 'Final price',
      finalQuestion: true,
      config: { correctPrice: 50, min: 0, max: 100 },
    }

    const saved = packs.replace(pack.id, {
      title: 'Finals',
      categories: [{ title: 'Final', clues: [clue] }],
    }) as { categories: Array<{ clues: Array<{ finalQuestion: boolean }> }> }
    expect(saved.categories[0]?.clues[0]?.finalQuestion).toBe(true)

    expect(() =>
      packs.replace(pack.id, {
        title: 'Finals',
        categories: [{ title: 'Final', clues: [clue, { ...clue, prompt: 'Another final' }] }],
      }),
    ).toThrow('only one Final Question')
  })

  it('persists optional answer reveal media on a clue', () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    database
      .prepare(
        `INSERT INTO media_assets
         (id, relative_path, original_name, mime_type, size_bytes)
         VALUES ('reveal-song', 'songs/reveal.mp3', 'reveal.mp3', 'audio/mpeg', 1)`,
      )
      .run()
    const packs = new PackRepository(database)
    const pack = packs.create({ title: 'Reveal audio' }) as { id: string }

    const saved = packs.replace(pack.id, {
      title: 'Reveal audio',
      categories: [
        {
          title: 'Prices',
          clues: [
            {
              type: 'price_slider',
              boardValue: 100,
              prompt: 'Guess it',
              revealMediaAssetId: 'reveal-song',
              config: { correctPrice: 50, min: 0, max: 100 },
            },
          ],
        },
      ],
    }) as { categories: Array<{ clues: Array<{ revealMediaAssetId: string | null }> }> }

    expect(saved.categories[0]?.clues[0]?.revealMediaAssetId).toBe('reveal-song')
  })
})

describe('content paths', () => {
  it('keeps media inside the configured root', () => {
    expect(resolveContentPath('C:\\content', 'songs\\clip.mp3')).toBe(
      'C:\\content\\songs\\clip.mp3',
    )
    expect(() => resolveContentPath('C:\\content', '..\\secret.txt')).toThrow(
      'outside the configured content directory',
    )
  })
})
