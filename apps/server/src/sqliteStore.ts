import type Database from 'better-sqlite3'
import type {
  AttemptRef, BoardEntry, DomainStore, FinalWager, GameClue, HistoryRow, LoadedRoom,
  MediaAsset, MediaCleanup, MediaDeletion, MediaInput, MediaStore, Page, PageRequest,
  RoomCommit, RoomRef, RoundOutcome, ScoreAward, Submission, UploadReservation,
} from './domain.js'
import { DomainError } from './domain.js'
import type { GameSettings, PlayerRecord, PlayerScore, RoomRecord, RoomState } from './game/types.js'
import { asPersistence, type DatabaseSource, Persistence, isUniqueViolation } from './persistence.js'
import { createId, createRoomCode } from './ids.js'
import { SqlitePackStore } from './sqlitePack.js'

export type DomainSource = DatabaseSource | DomainStore
const adapters = new WeakMap<object, DomainStore>()

export function domainFrom(source: DomainSource): DomainStore {
  if ('rooms' in source) return source
  let store = adapters.get(source)
  if (!store) {
    store = createSqliteStore(asPersistence(source))
    adapters.set(source, store)
  }
  return store
}
function page<T>(rows: T[], request?: PageRequest): Page<T> {
  if (!request) return { items: rows }
  const offset = Number(request.cursor ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new DomainError('conflict', 'Invalid cursor')
  const limit = Math.max(1, Math.min(100, request.limit ?? 100))
  const items = rows.slice(offset, offset + limit)
  return { items, ...(offset + limit < rows.length ? { cursor: String(offset + limit) } : {}) }
}
interface RoomRow {
  id: string; code: string; pack_id: string; host_token_hash: string; status: RoomRecord['status']
  settings_json: string; state_json: string; state_version: number; revision: number; joining_locked: number
  created_at: string; updated_at: string; completed_at: string | null
}
function room(row: RoomRow): RoomRecord {
  const settings = JSON.parse(row.settings_json) as GameSettings
  return {
    ref: { id: row.id, code: row.code, generation: row.id }, revision: String(row.revision),
    id: row.id, code: row.code, packId: row.pack_id, hostTokenHash: row.host_token_hash, status: row.status,
    settings: { ...settings, teams: settings.teams ?? [], specials: settings.specials ?? [] },
    state: JSON.parse(row.state_json) as RoomState, stateVersion: row.state_version,
    joiningLocked: Boolean(row.joining_locked), createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  }
}
interface PlayerRow {
  id: string; room_id: string; nickname: string; team_name: string | null; reconnect_token_hash: string
  connected: number; kicked: number; joined_at: string; last_seen_at: string
}
function player(row: PlayerRow): PlayerRecord {
  return { id: row.id, roomId: row.room_id, nickname: row.nickname, teamName: row.team_name,
    reconnectTokenHash: row.reconnect_token_hash, connected: Boolean(row.connected), kicked: Boolean(row.kicked),
    joinedAt: row.joined_at, lastSeenAt: row.last_seen_at }
}
function media(row: {
  id: string; relative_path: string; original_name: string; mime_type: string; size_bytes: number
  duration_seconds: number | null; created_at: string
}): MediaAsset {
  return { id: row.id, relativePath: row.relative_path, originalName: row.original_name, mimeType: row.mime_type,
    sizeBytes: row.size_bytes, durationSeconds: row.duration_seconds, createdAt: row.created_at }
}

export function createSqliteStore(database: Persistence | Database.Database): DomainStore {
  const db = asPersistence(database)
  const raw = db.sqlite!
  const packs = new SqlitePackStore(db)
  const getRoom = async (id: string) => {
    const row = await db.statement('roomGet').get(id) as RoomRow | undefined
    return row ? room(row) : undefined
  }
  const requireRef = async (ref: RoomRef) => {
    const current = await getRoom(ref.id)
    if (!current || current.code !== ref.code || current.ref.generation !== ref.generation)
      throw new DomainError('not_found', 'Room not found')
    return current
  }
  const loaded = async (ref: RoomRef): Promise<LoadedRoom> => {
    const current = await requireRef(ref)
    const scores = await db.statement('roomScores').all(ref.id) as Array<Omit<PlayerScore, 'connected'> & { connected: number }>
    return { ref, room: current, revision: current.revision, activeScores: scores.map((entry) => ({ ...entry, connected: Boolean(entry.connected) })) }
  }
  const writeAward = async (roomId: string, award: ScoreAward) => {
    if (!Number.isSafeInteger(award.delta)) throw new DomainError('conflict', 'Invalid score delta')
    await db.statement('scoreInsert').run(createId(), roomId, award.playerId, award.clueId ?? null, award.delta, award.source, award.reason, award.actor)
  }
  const mediaStore: MediaStore = {
    async list(request) { return page((await db.statement('mediaList').all() as Parameters<typeof media>[0][]).map(media), request) },
    async get(id) {
      const row = await db.statement('mediaGet').get(id) as Parameters<typeof media>[0] | undefined
      return row ? media(row) : undefined
    },
    async findByPath(path) {
      const row = await db.statement('mediaFindPath').get(path) as Parameters<typeof media>[0] | undefined
      return row ? media(row) : undefined
    },
    async createIfMissing(input) {
      return db.transaction(async () => {
        const existing = await mediaStore.findByPath(input.relativePath)
        if (existing) return existing
        const id = createId()
        await db.statement('mediaInsert').run(id, input.relativePath, input.originalName, input.mimeType, input.sizeBytes)
        return (await mediaStore.get(id))!
      })
    },
    async reserveUpload(operationId, ownedKeys) {
      return db.transaction(async () => {
        const existing = raw.prepare('SELECT value_json FROM media_operations WHERE id = ?').get(operationId) as { value_json: string } | undefined
        if (existing) {
          const reservation = JSON.parse(existing.value_json) as UploadReservation
          if (JSON.stringify(reservation.ownedKeys) !== JSON.stringify(ownedKeys)) throw new DomainError('conflict', 'Operation ID reused')
          return reservation
        }
        const reservation: UploadReservation = { id: operationId, operationId, ownedKeys, reservedBytes: 0 }
        raw.prepare("INSERT INTO media_operations VALUES (?, 'upload', ?)").run(operationId, JSON.stringify(reservation))
        return reservation
      })
    },
    async growReservation(reservation, totalBytes) {
      if (!Number.isSafeInteger(totalBytes) || totalBytes < reservation.reservedBytes) throw new DomainError('conflict', 'Invalid reservation size')
      return db.transaction(async () => {
        const row = raw.prepare("SELECT value_json FROM media_operations WHERE id = ? AND kind = 'upload'").get(reservation.id) as { value_json: string } | undefined
        if (!row) throw new DomainError('not_found', 'Upload reservation not found')
        const current = JSON.parse(row.value_json) as UploadReservation
        const next = { ...current, reservedBytes: Math.max(current.reservedBytes, totalBytes) }
        raw.prepare('UPDATE media_operations SET value_json = ? WHERE id = ?').run(JSON.stringify(next), reservation.id)
        return next
      })
    },
    async commitUploaded(reservation, input, actualBytes) {
      return db.transaction(async () => {
        const row = raw.prepare("SELECT value_json FROM media_operations WHERE id = ? AND kind = 'upload'").get(reservation.id) as { value_json: string } | undefined
        if (!row) throw new DomainError('not_found', 'Upload reservation not found')
        const current = JSON.parse(row.value_json) as UploadReservation
        if (!current.ownedKeys.includes(input.relativePath) || !Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > current.reservedBytes)
          throw new DomainError('conflict', 'Upload does not match its reservation')
        const asset = await mediaStore.createIfMissing({ ...input, sizeBytes: actualBytes })
        raw.prepare('DELETE FROM media_operations WHERE id = ?').run(reservation.id)
        return asset
      })
    },
    async abortUpload(reservation, deletedKeys) {
      await db.transaction(async () => {
        if (!reservation.ownedKeys.every((key) => deletedKeys.includes(key))) throw new DomainError('conflict', 'Upload cleanup is incomplete')
        raw.prepare('DELETE FROM media_operations WHERE id = ?').run(reservation.id)
      })
    },
    async claim() {},
    async releaseClaims() { return { done: true } },
    async completeOperation() {},
    async beginDelete(id, operationId) {
      return db.transaction(async () => {
        const pending = raw.prepare("SELECT value_json FROM media_operations WHERE kind = 'delete' AND json_extract(value_json, '$.id') = ?").get(id) as { value_json: string } | undefined
        if (pending) return JSON.parse(pending.value_json) as MediaDeletion
        const asset = await mediaStore.get(id)
        if (!asset) return undefined
        const ticket: MediaDeletion = { id, operationId, asset }
        raw.prepare("INSERT INTO media_operations VALUES (?, 'delete', ?) ON CONFLICT(id) DO NOTHING").run(operationId, JSON.stringify(ticket))
        return ticket
      })
    },
    async finishDelete(ticket, confirmedAbsent) {
      if (!confirmedAbsent) throw new DomainError('conflict', 'Media object still exists')
      await db.transaction(async () => {
        const current = await mediaStore.get(ticket.id)
        if (current && current.relativePath !== ticket.asset.relativePath) throw new DomainError('conflict', 'Media changed')
        await db.statement('mediaDelete').run(ticket.id)
        raw.prepare('DELETE FROM media_operations WHERE id = ?').run(ticket.operationId)
      })
    },
    async pendingCleanup(request) {
      return db.transaction(async () => {
        const rows = raw.prepare('SELECT kind, value_json FROM media_operations ORDER BY id').all() as Array<{ kind: string; value_json: string }>
        return page(rows.map((row): MediaCleanup => row.kind === 'upload'
          ? { kind: 'upload', reservation: JSON.parse(row.value_json) as UploadReservation }
          : { kind: 'delete', ticket: JSON.parse(row.value_json) as MediaDeletion }), request)
      })
    },
  }
  const store: DomainStore = {
    mode: 'local',
    packs: {
      async list(includeArchived, request) { return page(await packs.list(includeArchived), request) },
      get: (id) => packs.get(id),
      create: (input) => packs.create(input),
      async replace(id, input, expectedRevision, _operationId, importOwner) {
        return db.transaction(async () => {
          const current = await packs.get(id)
          if (!current) return undefined
          if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Pack changed; refresh and try again')
          const result = await packs.replace(id, input)
          if (result && importOwner) await mediaStore.completeOperation(importOwner)
          return result
        })
      },
      archive: (id) => packs.archive(id),
      remove: (id) => packs.remove(id),
    },
    rooms: {
      async resolveCode(code) {
        const row = await db.statement('roomByCode').get(code.toUpperCase()) as RoomRow | undefined
        return row ? room(row).ref : undefined
      },
      async resolveId(id) { return (await getRoom(id))?.ref },
      load: loaded,
      async loadPlayer(ref, id) { await requireRef(ref); const row = await db.statement('playerGet').get(id) as PlayerRow | undefined; return row?.room_id === ref.id ? player(row) : undefined },
      async findPlayer(id) { const row = await db.statement('playerGet').get(id) as PlayerRow | undefined; return row ? player(row) : undefined },
      async listPlayers(ref) { await requireRef(ref); return (await db.statement('roomPlayers').all(ref.id) as PlayerRow[]).map(player) },
      async board(ref) { return await db.statement('packBoard').all((await requireRef(ref)).packId) as BoardEntry[] },
      async clue(ref, id) {
        const current = await requireRef(ref)
        if (!await db.statement('clueBelongsToPack').get(id, current.packId)) return undefined
        const row = await db.statement('clueGet').get(id) as {
          id: string; category_id: string; type: GameClue['type']; board_value: number; prompt: string; timer_seconds: number
          config_json: string; media_asset_id: string | null; reveal_media_asset_id: string | null; is_final: number
        } | undefined
        return row ? { id: row.id, categoryId: row.category_id, type: row.type, boardValue: row.board_value,
          prompt: row.prompt, timerSeconds: row.timer_seconds, config: JSON.parse(row.config_json) as Record<string, unknown>,
          mediaAssetId: row.media_asset_id, revealMediaAssetId: row.reveal_media_asset_id, finalQuestion: Boolean(row.is_final) } : undefined
      },
      async finalClueId(ref) { return (await db.statement('packFinalClue').get((await requireRef(ref)).packId) as { id: string } | undefined)?.id },
      async wagers(ref, attempt) {
        await requireRef(ref)
        return (await db.statement('clueWagers').all(ref.id, attempt.clueId) as Array<{ player_id: string; amount: number }>).map((row) => ({ playerId: row.player_id, amount: row.amount }))
      },
      async submissions(ref, attempt, request, order = 'receipt') {
        const current = await requireRef(ref)
        if (attempt.attempt !== (current.state.attempt ?? 0)) return { items: [] }
        const clue = await store.rooms.clue(ref, attempt.clueId)
        const target = Number(clue?.config.correctPrice)
        const rows = await db.transaction(async () => {
          const offset = Number(request?.cursor ?? 0), limit = Math.max(1, Math.min(100, request?.limit ?? 100))
          if (!Number.isSafeInteger(offset) || offset < 0) throw new DomainError('conflict', 'Invalid cursor')
          const filter = order === 'receipt' ? '' : order === 'priceEligible'
            ? ' AND CAST(answer_json AS REAL) <= ?' : ' AND CAST(answer_json AS REAL) > ?'
          const sorting = order === 'receipt' ? 'elapsed_ms, id' : order === 'priceEligible'
            ? 'CAST(answer_json AS REAL) DESC, player_id' : 'CAST(answer_json AS REAL), player_id'
          const args = order === 'receipt' ? [ref.id, attempt.clueId, limit + 1, offset] : [ref.id, attempt.clueId, target, limit + 1, offset]
          return raw.prepare(`SELECT * FROM submissions WHERE room_id = ? AND clue_id = ?${filter} ORDER BY ${sorting} LIMIT ? OFFSET ?`).all(...args) as Array<{ id: string; player_id: string; answer_json: string; elapsed_ms: number; received_at: string }>
        })
        const offset = Number(request?.cursor ?? 0), limit = Math.max(1, Math.min(100, request?.limit ?? 100))
        const more = rows.length > limit
        if (more) rows.pop()
        return { items: rows.map((row): Submission => ({ id: row.id, playerId: row.player_id, answer: JSON.parse(row.answer_json), elapsedMs: row.elapsed_ms, receivedAt: row.received_at })),
          ...(more ? { cursor: String(offset + limit) } : {}) }
      },
      async submissionForPlayer(ref, attempt, playerId) {
        await requireRef(ref)
        return db.transaction(async () => {
          const row = raw.prepare('SELECT * FROM submissions WHERE room_id = ? AND clue_id = ? AND player_id = ?').get(ref.id, attempt.clueId, playerId) as
            { id: string; player_id: string; answer_json: string; elapsed_ms: number; received_at: string } | undefined
          return row ? { id: row.id, playerId: row.player_id, answer: JSON.parse(row.answer_json), elapsedMs: row.elapsed_ms, receivedAt: row.received_at } : undefined
        })
      },
      async prepareResult(ref, expectedRevision, resultId, chunkIndex, chunk) {
        await db.transaction(async () => {
          if ((await requireRef(ref)).revision !== expectedRevision) throw new DomainError('conflict', 'Room changed while scoring')
          if (chunk.entries.length > 50 || chunk.awards.length > 50) throw new DomainError('conflict', 'Result chunk is too large')
          raw.prepare('INSERT INTO result_chunks VALUES (?, ?, ?, ?)').run(ref.id, resultId, chunkIndex, JSON.stringify(chunk))
        })
      },
      async results(ref, attempt, request) {
        await requireRef(ref)
        const rows = await db.statement('clueSubmissions').all(ref.id, attempt.clueId) as Array<{ id: string; player_id: string; answer_json: string; elapsed_ms: number; received_at: string; correct: number; rank: number | null; points_awarded: number; evaluation_json: string | null }>
        return page(rows.map((row): RoundOutcome => ({ submissionId: row.id, playerId: row.player_id, answer: JSON.parse(row.answer_json),
          elapsedMs: row.elapsed_ms, receivedAt: row.received_at, correct: Boolean(row.correct),
          ...(row.rank !== null ? { rank: row.rank } : {}), points: row.points_awarded ?? 0,
          evaluation: row.evaluation_json ? JSON.parse(row.evaluation_json) : null, synthetic: row.answer_json === 'null' })), request)
      },
      async appliedAwards(ref, attempt) {
        await requireRef(ref)
        const active = new Set((await store.rooms.listPlayers(ref)).map(({ id }) => id))
        return (await db.statement('clueAppliedScores').all(ref.id, attempt.clueId) as Array<{ playerId: string; points: number }>).filter((row) => active.has(row.playerId)).map((row): ScoreAward => ({
          playerId: row.playerId, clueId: attempt.clueId, delta: row.points, source: 'void', reason: '', actor: 'host',
        }))
      },
      async commit(command) {
        return db.transaction(async () => {
          const current = await requireRef(command.ref)
          const payload = JSON.stringify({ ...command, expectedRevision: undefined, at: undefined })
          const receipt = raw.prepare('SELECT payload FROM domain_receipts WHERE room_id = ? AND operation_id = ?').get(command.ref.id, command.operationId) as { payload: string } | undefined
          if (receipt) {
            if (receipt.payload !== payload) throw new DomainError('conflict', 'Operation ID reused with different data')
            return loaded(command.ref)
          }
          if (current.revision !== command.expectedRevision) throw new DomainError('conflict', 'Room state changed; refresh and try again')
          const change = command.change
          const attempt = current.state.attempt ?? 0
          if ('attempt' in change && (change.attempt.attempt !== attempt || change.attempt.clueId !== current.state.activeClueId))
            throw new DomainError('stale_attempt', 'This question has changed')
          try {
            switch (change.kind) {
              case 'none': break
              case 'join':
                if ((await store.rooms.listPlayers(command.ref)).length >= 50) throw new DomainError('room_full', 'This room is full')
                await db.statement('playerInsert').run(change.player.id, current.id, change.player.nickname, change.player.teamName, change.player.reconnectTokenHash)
                break
              case 'connection': await db.statement('playerConnected').run(change.connected ? 1 : 0, change.playerId); break
              case 'kick': await db.statement('playerKick').run(change.playerId, current.id); break
              case 'wager':
                if (change.generation !== (current.state.wagerGeneration ?? 0)) throw new DomainError('stale_attempt', 'This wager has changed')
                await db.statement('clueInsertWager').run(current.id, change.wager.playerId, change.attempt.clueId, change.wager.amount); break
              case 'submission':
                if (change.window !== (current.state.window ?? 0)) throw new DomainError('stale_attempt', 'This answer window has changed')
                await db.statement('clueInsertAnswer').run(change.submission.id, current.id, change.submission.playerId, change.clue.id,
                  JSON.stringify(change.submission.answer), change.submission.elapsedMs, change.clue.prompt, change.clue.type, change.clue.categoryId, change.submission.receivedAt)
                break
              case 'settle':
                raw.prepare('INSERT INTO round_results VALUES (?, ?, ?, ?, NULL)').run(current.id, change.result.attempt.clueId, change.result.attempt.attempt, JSON.stringify(change.result))
                {
                  const apply = async (chunk: { entries: RoundOutcome[]; awards: ScoreAward[] }) => {
                    for (const entry of chunk.entries) {
                      if (entry.synthetic) await db.statement('clueInsertSpecialSubmission').run(entry.submissionId, current.id, entry.playerId, change.result.clue.id,
                        entry.elapsedMs, entry.correct ? 1 : 0, entry.points, JSON.stringify(entry.evaluation), change.result.clue.prompt, change.result.clue.type, change.result.clue.categoryId)
                      else await db.statement('submissionEvaluate').run(entry.correct ? 1 : 0, entry.rank ?? null, entry.points, JSON.stringify(entry.evaluation), entry.submissionId)
                    }
                    for (const award of chunk.awards) await writeAward(current.id, award)
                  }
                  for (let index = 0; index < (change.result.stagedChunks ?? 0); index++) {
                    const row = raw.prepare('SELECT value_json FROM result_chunks WHERE room_id = ? AND result_id = ? AND chunk_index = ?').get(current.id, change.result.id, index) as { value_json: string } | undefined
                    if (!row) throw new DomainError('conflict', 'Staged result is incomplete')
                    await apply(JSON.parse(row.value_json) as { entries: RoundOutcome[]; awards: ScoreAward[] })
                  }
                  await apply(change.result)
                }
                break
              case 'invalidate':
                raw.prepare(`INSERT INTO score_events (id, room_id, player_id, clue_id, delta, source, reason, actor)
                  SELECT lower(hex(randomblob(16))), room_id, player_id, clue_id, -SUM(delta), 'void', ?, 'host'
                  FROM score_events WHERE room_id = ? AND clue_id = ? AND source IN ('music','price','void')
                  GROUP BY player_id HAVING SUM(delta) != 0`)
                  .run(change.reason === 'reset' ? 'Clue reset' : change.reason === 'goBack' ? 'Clue returned to board' : 'Clue voided by host', current.id, change.attempt.clueId)
                raw.prepare('UPDATE round_results SET invalidated = ? WHERE room_id = ? AND clue_id = ? AND attempt = ?').run(change.reason, current.id, change.attempt.clueId, change.attempt.attempt)
                if (change.reason === 'void') await db.statement('clueVoidSubmissions').run(change.special ?? null, current.id, change.attempt.clueId)
                else await db.statement('clueDeleteSubmissions').run(current.id, change.attempt.clueId)
                if (change.reason === 'goBack') await db.statement('clueDeleteWagers').run(current.id, change.attempt.clueId)
                break
              case 'adjustment': await writeAward(current.id, change.award); break
            }
          } catch (error) {
            if (!isUniqueViolation(error)) throw error
            if (change.kind === 'join') throw new DomainError('nickname_taken', 'That nickname is already in use')
            if (change.kind === 'submission') throw new DomainError('duplicate_answer', 'You already answered this clue')
            if (change.kind === 'wager') throw new DomainError('duplicate_wager', 'Your final wager is already locked')
            throw new DomainError('conflict', 'Room command already applied')
          }
          if (command.state) {
            const state = command.state
            if (state.nextStateVersion <= current.stateVersion) throw new DomainError('conflict', 'Invalid state version')
            raw.prepare(`UPDATE rooms SET state_json = ?, status = ?, state_version = ?, joining_locked = ?,
              completed_at = CASE WHEN ? IN ('finished','abandoned') THEN ? ELSE completed_at END WHERE id = ?`)
              .run(JSON.stringify(state.value), state.status, state.nextStateVersion, state.joiningLocked ? 1 : 0, state.status, command.at, current.id)
            await db.statement('roomInsertSnapshot').run(current.id, state.nextStateVersion, JSON.stringify(state.value))
          }
          raw.prepare('UPDATE rooms SET revision = revision + 1, updated_at = ? WHERE id = ?').run(command.at, current.id)
          raw.prepare('INSERT INTO domain_receipts VALUES (?, ?, ?)').run(current.id, command.operationId, payload)
          return loaded(command.ref)
        })
      },
      async create(packId, settings, tokenHash, codeLength) {
        return db.transaction(async () => {
          const pack = await db.statement('roomPackEligibility').get(packId) as { status: string; clue_count: number; ordinary_clue_count: number } | undefined
          if (!pack) throw new DomainError('not_found', 'Pack not found')
          if (pack.status !== 'ready' || pack.clue_count === 0) throw new DomainError('conflict', 'Pack must be marked ready and contain at least one clue')
          if ((settings.specials?.length ?? 0) > pack.ordinary_clue_count) throw new DomainError('conflict', `This pack needs at least ${settings.specials?.length ?? 0} ordinary clues for the selected specials`)
          for (let tries = 0; tries < 20; tries++) {
            const id = createId(), code = createRoomCode(codeLength)
            try {
              await db.statement('roomInsert').run(id, code, packId, tokenHash, JSON.stringify(settings), JSON.stringify({ phase: 'LOBBY', usedClueIds: [], specialAssignments: {}, attempt: 0, window: 0, wagerGeneration: 0 }))
              return loaded({ id, code, generation: id })
            } catch (error) { if (!isUniqueViolation(error, 'rooms.code')) throw error }
          }
          throw new DomainError('conflict', 'Unable to allocate a room code')
        })
      },
      async interrupted(request) { return page((await db.statement('roomActive').all() as RoomRow[]).map((row) => room(row).ref), request) },
      async forPack(packId, request) {
        const ids = await db.statement('packRooms').all(packId) as Array<{ id: string }>
        return page(await Promise.all(ids.map(async ({ id }) => (await getRoom(id))!.ref)), request)
      },
      async disconnectAll() { await db.statement('playersDisconnectAll').run() },
    },
    history: {
      async list(request) { return page(await db.statement('historyList').all() as HistoryRow[], request) },
      async header(id) { return await db.statement('historyRoom').get(id) as HistoryRow | undefined },
      async players(id, request) { return page(await db.statement('historyPlayers').all(id) as HistoryRow[], request) },
      async submissions(id, request) { return page(await db.statement('historySubmissions').all(id) as HistoryRow[], request) },
      async exportRows(id, request) { return page(await db.statement('historyExport').all(id) as HistoryRow[], request) },
      async removeCompleted(id) {
        return db.transaction(async () => {
          if ((await db.statement('historyDelete').run(id)).changes) return 'deleted'
          return await db.statement('historyRoomStatus').get(id) ? 'active' : 'not_found'
        })
      },
      async removeAllCompleted() { return (await db.statement('historyDeleteAll').run()).changes },
    },
    media: mediaStore,
    settings: {
      async gifKey(provider) { return (await db.statement('settingGet').get(`gif.${provider}.apiKey`) as { value: string } | undefined)?.value },
      async setGifKey(provider, key) { await db.statement('settingSave').run(`gif.${provider}.apiKey`, key) },
    },
    async recover() {
      await db.transaction(async () => raw.prepare(`DELETE FROM result_chunks WHERE NOT EXISTS
        (SELECT 1 FROM round_results r WHERE r.room_id = result_chunks.room_id AND json_extract(r.result_json, '$.id') = result_chunks.result_id)`).run())
    },
    close: () => db.close(),
  }
  return store
}
