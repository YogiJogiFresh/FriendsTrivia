import type Database from 'better-sqlite3'

import type {
  GameSettings,
  PlayerRecord,
  PlayerScore,
  RoomRecord,
  RoomState,
} from '../game/types.js'
import { createId, createRoomCode, createToken, hashToken, tokenMatches } from '../ids.js'

interface RoomRow {
  id: string
  code: string
  pack_id: string
  host_token_hash: string
  status: RoomRecord['status']
  settings_json: string
  state_json: string
  state_version: number
  joining_locked: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface PlayerRow {
  id: string
  room_id: string
  nickname: string
  team_name: string | null
  reconnect_token_hash: string
  connected: number
  kicked: number
  joined_at: string
  last_seen_at: string
}

interface PlayerScoreRow {
  playerId: string
  nickname: string
  teamName: string | null
  score: number
  connected: number
}

function mapRoom(row: RoomRow): RoomRecord {
  return {
    id: row.id,
    code: row.code,
    packId: row.pack_id,
    hostTokenHash: row.host_token_hash,
    status: row.status,
    settings: (() => {
      const settings = JSON.parse(row.settings_json) as GameSettings
      return { ...settings, teams: settings.teams ?? [], specials: settings.specials ?? [] }
    })(),
    state: JSON.parse(row.state_json) as RoomState,
    stateVersion: row.state_version,
    joiningLocked: Boolean(row.joining_locked),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function mapPlayer(row: PlayerRow): PlayerRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    nickname: row.nickname,
    teamName: row.team_name,
    reconnectTokenHash: row.reconnect_token_hash,
    connected: Boolean(row.connected),
    kicked: Boolean(row.kicked),
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  }
}

export class RoomRepository {
  constructor(private readonly database: Database.Database) {}

  create(
    packId: string,
    settings: GameSettings,
    codeLength: number,
  ): { room: RoomRecord; hostToken: string } {
    const pack = this.database
      .prepare(
        `SELECT p.id, p.status, COUNT(q.id) AS clue_count,
                SUM(CASE WHEN q.is_final = 0 THEN 1 ELSE 0 END) AS ordinary_clue_count
         FROM packs p
         LEFT JOIN categories c ON c.pack_id = p.id AND c.archived = 0
         LEFT JOIN clues q ON q.category_id = c.id AND q.archived = 0
         WHERE p.id = ? AND p.status != 'archived'
         GROUP BY p.id`,
      )
      .get(packId) as
        | { id: string; status: string; clue_count: number; ordinary_clue_count: number }
        | undefined
    if (!pack) throw new Error('Pack not found')
    if (pack.status !== 'ready' || pack.clue_count === 0) {
      throw new Error('Pack must be marked ready and contain at least one clue')
    }
    if ((settings.specials?.length ?? 0) > pack.ordinary_clue_count) {
      throw new Error(
        `This pack needs at least ${settings.specials?.length ?? 0} ordinary clues for the selected specials`,
      )
    }

    const hostToken = createToken()
    const initialState: RoomState = { phase: 'LOBBY', usedClueIds: [], specialAssignments: {} }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = createId()
      const code = createRoomCode(codeLength)
      try {
        this.database
          .prepare(
            `INSERT INTO rooms
             (id, code, pack_id, host_token_hash, status, settings_json, state_json)
             VALUES (?, ?, ?, ?, 'lobby', ?, ?)`,
          )
          .run(
            id,
            code,
            packId,
            hashToken(hostToken),
            JSON.stringify(settings),
            JSON.stringify(initialState),
          )
        const room = this.getById(id)
        if (!room) throw new Error('Room was not created')
        return { room, hostToken }
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('rooms.code')) throw error
      }
    }
    throw new Error('Unable to allocate a room code')
  }

  getById(id: string): RoomRecord | undefined {
    const row = this.database.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as
      | RoomRow
      | undefined
    return row ? mapRoom(row) : undefined
  }

  getByCode(code: string): RoomRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM rooms WHERE code = ?')
      .get(code.toUpperCase()) as RoomRow | undefined
    return row ? mapRoom(row) : undefined
  }

  isHost(room: RoomRecord, token: string): boolean {
    return tokenMatches(token, room.hostTokenHash)
  }

  join(
    room: RoomRecord,
    nickname: string,
    teamName?: string,
  ): { player: PlayerRecord; reconnectToken: string } {
    if (room.joiningLocked || room.status === 'finished' || room.status === 'abandoned') {
      throw new Error('This room is not accepting players')
    }
    const playerCount = this.database
      .prepare('SELECT COUNT(*) AS count FROM players WHERE room_id = ? AND kicked = 0')
      .get(room.id) as { count: number }
    if (playerCount.count >= 50) throw new Error('This room is full')
    const teams = room.settings.teams ?? []
    const canonicalTeam = teams.find(
      (team) => team.toLocaleLowerCase() === teamName?.trim().toLocaleLowerCase(),
    )
    if (teams.length > 0 && !canonicalTeam) throw new Error('Choose a valid team')

    const reconnectToken = createToken()
    const id = createId()
    try {
      this.database
        .prepare(
          `INSERT INTO players
           (id, room_id, nickname, team_name, reconnect_token_hash, connected)
           VALUES (?, ?, ?, ?, ?, 1)`,
        )
        .run(id, room.id, nickname, canonicalTeam ?? null, hashToken(reconnectToken))
    } catch (error) {
      if (error instanceof Error && error.message.includes('players.room_id')) {
        throw new Error('That nickname is already in use')
      }
      throw error
    }
    const player = this.getPlayer(id)
    if (!player) throw new Error('Player was not created')
    return { player, reconnectToken }
  }

  reconnect(room: RoomRecord, playerId: string, token: string): PlayerRecord | undefined {
    const player = this.getPlayer(playerId)
    if (
      !player ||
      player.roomId !== room.id ||
      player.kicked ||
      !tokenMatches(token, player.reconnectTokenHash)
    ) {
      return undefined
    }
    this.setConnected(player.id, true)
    return this.getPlayer(player.id)
  }

  getPlayer(id: string): PlayerRecord | undefined {
    const row = this.database.prepare('SELECT * FROM players WHERE id = ?').get(id) as
      | PlayerRow
      | undefined
    return row ? mapPlayer(row) : undefined
  }

  listPlayers(roomId: string): PlayerRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM players WHERE room_id = ? AND kicked = 0 ORDER BY joined_at')
        .all(roomId) as PlayerRow[]
    ).map(mapPlayer)
  }

  scores(roomId: string): PlayerScore[] {
    const rows = this.database
      .prepare(
        `SELECT p.id AS playerId, p.nickname, p.team_name AS teamName, p.connected,
                COALESCE(SUM(s.delta), 0) AS score
         FROM players p
         LEFT JOIN score_events s ON s.player_id = p.id
         WHERE p.room_id = ? AND p.kicked = 0
         GROUP BY p.id
         ORDER BY score DESC, p.joined_at`,
      )
      .all(roomId) as PlayerScoreRow[]
    return rows.map((score) => ({ ...score, connected: Boolean(score.connected) }))
  }

  setConnected(playerId: string, connected: boolean): void {
    this.database
      .prepare(
        `UPDATE players SET connected = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(connected ? 1 : 0, playerId)
  }

  setJoiningLocked(roomId: string, locked: boolean): void {
    this.database
      .prepare(
        `UPDATE rooms SET joining_locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(locked ? 1 : 0, roomId)
  }

  kickPlayer(roomId: string, playerId: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE players SET kicked = 1, connected = 0, last_seen_at = CURRENT_TIMESTAMP
           WHERE id = ? AND room_id = ?`,
        )
        .run(playerId, roomId).changes > 0
    )
  }

  saveState(
    roomId: string,
    state: RoomState,
    status: RoomRecord['status'],
    expectedVersion: number,
  ): RoomRecord {
    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE rooms SET state_json = ?, status = ?, state_version = state_version + 1,
           updated_at = CURRENT_TIMESTAMP,
           completed_at = CASE WHEN ? IN ('finished', 'abandoned') THEN CURRENT_TIMESTAMP ELSE completed_at END
           WHERE id = ? AND state_version = ?`,
        )
        .run(JSON.stringify(state), status, status, roomId, expectedVersion)
      if (result.changes !== 1) throw new Error('Room state changed; refresh and try again')
      const room = this.getById(roomId)
      if (!room) throw new Error('Room disappeared during state update')
      this.database
        .prepare(
          `INSERT INTO game_snapshots (room_id, state_version, state_json)
           VALUES (?, ?, ?)`,
        )
        .run(room.id, room.stateVersion, JSON.stringify(room.state))
      return room
    })()
  }

  pauseActiveRooms(): number {
    const rooms = this.database
      .prepare("SELECT * FROM rooms WHERE status = 'active'")
      .all() as RoomRow[]
    const update = this.database.prepare(
      `UPDATE rooms SET status = 'paused', state_json = ?, state_version = state_version + 1,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    this.database.transaction(() => {
      for (const row of rooms) {
        const room = mapRoom(row)
        const deadline = room.state.deadline ? Date.parse(room.state.deadline) : undefined
        const state: RoomState = {
          ...room.state,
          phase: 'PAUSED',
          previousPhase: room.state.phase,
          remainingMs: deadline ? Math.max(0, deadline - Date.now()) : undefined,
          deadline: undefined,
        }
        update.run(JSON.stringify(state), room.id)
      }
    })()
    return rooms.length
  }
}
