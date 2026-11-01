import { createId, createRoomCode } from '../ids.js'
import { DomainError, type AttemptRef, type BoardEntry, type FinalWager, type GameClue,
  type LoadedRoom, type PackDocument, type Page, type PageRequest, type RoomCommit, type RoomRef,
  type RoomStore, type RoundOutcome, type RoundResult, type ScoreAward, type Submission } from '../domain.js'
import type { GameSettings, PlayerRecord, PlayerScore, RoomRecord } from '../game/types.js'
import { CosmosPacks } from './cosmosPacks.js'
import { conflict, digest, document, etag, now, pageLimit, pages, remove, replace, writeChunks,
  type CosmosAccess, type Document, type Query, type Write } from './cosmosIo.js'

export interface Reservation extends Document {
  ref: RoomRef; status: 'staging' | 'ready' | 'deleting' | 'free'; packId: string; operationId: string
}
export interface RoomDoc extends Document {
  generation: string; room: RoomRecord; activeScores: PlayerScore[]; packTitle: string; packRevision: string; deleting: boolean
}
interface Locator extends Document { ref: RoomRef; generation: string }
export interface PlayerDoc extends Document { generation: string; player: PlayerRecord }
export interface ClueDoc extends Document { generation: string; clue: GameClue; board: BoardEntry }
export interface SubmissionDoc extends Document { generation: string; attempt: AttemptRef; submission: Submission; clue: GameClue; price: number | null }
interface WagerDoc extends Document { generation: string; clueId: string; wagerGeneration: number; wager: FinalWager }
export interface ResultDoc extends Document { generation: string; result: RoundResult }
interface ResultChunk extends Document { generation: string; resultId: string; chunkIndex: number; entries: RoundOutcome[]; awards: ScoreAward[]; payload: string }
export interface Invalidation extends Document { generation: string; attempt: AttemptRef; reason: 'reset' | 'goBack' | 'void'; special: string | null }
export interface Audit extends Document { generation: string; award?: ScoreAward; change?: RoomCommit['change']; at: string }
interface Receipt extends Document { generation: string; payload: string }
interface CreationReceipt extends Document { ref: RoomRef; payload: string }
export const roomItemId = (ref: RoomRef, suffix: string) => `g:${ref.generation}:${suffix}`
export const attemptKey = (attempt: AttemptRef) => `${attempt.clueId}:${attempt.attempt}`
export const resultItemId = (ref: RoomRef, attempt: AttemptRef) => roomItemId(ref, `result:${attemptKey(attempt)}`)
export const invalidationItemId = (ref: RoomRef, attempt: AttemptRef) => roomItemId(ref, `invalid:${attemptKey(attempt)}`)
const clone = <T>(value: T): T => structuredClone(value)
const safeScore = (value: bigint) => value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
function cursor(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function parseCursor<T>(value: string): T {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString()) as T }
  catch { throw new DomainError('conflict', 'Invalid result cursor') }
}
export class CosmosRooms implements RoomStore {
  private readonly writes = new Map<string, Promise<unknown>>()
  private serialize<T>(code: string, action: () => Promise<T>): Promise<T> {
    const result = (this.writes.get(code) ?? Promise.resolve()).then(action)
    const tail = result.catch(() => undefined)
    this.writes.set(code, tail)
    void tail.then(() => { if (this.writes.get(code) === tail) this.writes.delete(code) })
    return result
  }
  constructor(readonly access: CosmosAccess, readonly packs: CosmosPacks, private readonly roomCode = createRoomCode) {
    packs.deleteRooms = async (packId) => {
      // Consume page one repeatedly; cleanup changes query membership.
      while (true) {
        const result = await this.access.query<Reservation>({ filters: [
          { field: 'kind', value: 'reservation' }, { field: 'packId', value: packId },
          { field: 'status', op: 'IN', value: ['staging', 'ready', 'deleting'] },
        ] }, { limit: 50 })
        if (!result.items.length) break
        for (const item of result.items) await this.delete(item.ref, false)
      }
    }
  }
  query(ref: RoomRef, kind: string): Query {
    return { pk: ref.code, filters: [{ field: 'generation', value: ref.generation }, { field: 'kind', value: kind }] }
  }
  async reservation(ref: RoomRef, allowDeleting = false): Promise<Reservation> {
    const reservation = await this.access.read<Reservation>(ref.code, 'reservation')
    if (!reservation || reservation.ref.id !== ref.id || reservation.ref.generation !== ref.generation ||
      (!allowDeleting && reservation.status !== 'ready'))
      throw new DomainError('not_found', 'Room not found')
    return reservation
  }
  async resolveCode(code: string): Promise<RoomRef | undefined> {
    const normalized = code.trim().toUpperCase()
    const reservation = await this.access.read<Reservation>(normalized, 'reservation')
    return reservation?.status === 'ready' ? reservation.ref : undefined
  }
  async resolveId(id: string): Promise<RoomRef | undefined> {
    const locator = await this.access.read<Locator>(`id:${id}`, 'locator')
    if (!locator) return undefined
    const ref = await this.resolveCode(locator.ref.code)
    return ref?.generation === locator.ref.generation && ref.id === id ? ref : undefined
  }
  async roomDoc(ref: RoomRef): Promise<RoomDoc> {
    await this.reservation(ref)
    const doc = await this.access.read<RoomDoc>(ref.code, roomItemId(ref, 'room'))
    if (!doc || doc.generation !== ref.generation) throw new DomainError('unavailable', 'Room documents are incomplete')
    if (doc.activeScores.length > 50) throw new DomainError('unavailable', 'Room roster exceeds the active player limit')
    return doc
  }
  async load(ref: RoomRef): Promise<LoadedRoom> {
    const doc = await this.roomDoc(ref), revision = etag(doc)
    return { ref, room: { ...clone(doc.room), revision }, revision, activeScores: clone(doc.activeScores) }
  }
  async loadPlayer(ref: RoomRef, id: string): Promise<PlayerRecord | undefined> {
    await this.reservation(ref)
    return (await this.access.read<PlayerDoc>(ref.code, roomItemId(ref, `player:${id}`)))?.player
  }
  async findPlayer(id: string): Promise<PlayerRecord | undefined> {
    const locator = await this.access.read<Locator>(`player:${id}`, 'locator')
    if (!locator || !await this.resolveId(locator.ref.id)) return undefined
    return this.loadPlayer(locator.ref, id)
  }
  async listPlayers(ref: RoomRef): Promise<PlayerRecord[]> {
    const doc = await this.roomDoc(ref)
    if (!doc.activeScores.length) return []
    const query = this.query(ref, 'player')
    query.filters.push({ field: 'player.id', op: 'IN', value: doc.activeScores.map(({ playerId }) => playerId) })
    const players = new Map<string, PlayerRecord>()
    for await (const item of pages<PlayerDoc>(this.access, query)) players.set(item.player.id, item.player)
    return doc.activeScores.map(({ playerId }) => {
      const player = players.get(playerId)
      if (!player || player.kicked) throw new DomainError('unavailable', 'Room player roster is inconsistent')
      return player
    })
  }
  async board(ref: RoomRef): Promise<BoardEntry[]> {
    await this.reservation(ref)
    const board: BoardEntry[] = []
    for await (const doc of pages<ClueDoc>(this.access, this.query(ref, 'frozenClue')))
      if (!doc.clue.finalQuestion) board.push(doc.board)
    return board.sort((a, b) => a.categoryPosition - b.categoryPosition || a.cluePosition - b.cluePosition)
  }
  async clue(ref: RoomRef, id: string): Promise<GameClue | undefined> {
    await this.reservation(ref)
    return (await this.access.read<ClueDoc>(ref.code, roomItemId(ref, `clue:${id}`)))?.clue
  }
  async finalClueId(ref: RoomRef): Promise<string | undefined> {
    await this.reservation(ref)
    const query = this.query(ref, 'frozenClue')
    query.filters.push({ field: 'clue.finalQuestion', value: true })
    return (await this.access.query<ClueDoc>(query, { limit: 1 })).items[0]?.clue.id
  }
  async wagers(ref: RoomRef, attempt: AttemptRef): Promise<FinalWager[]> {
    const doc = await this.roomDoc(ref), query = this.query(ref, 'wager')
    if (await this.access.read(ref.code, roomItemId(ref, `wagerClear:${attempt.clueId}:${doc.room.state.wagerGeneration ?? 0}`)))
      return []
    query.filters.push({ field: 'clueId', value: attempt.clueId }, { field: 'wagerGeneration', value: doc.room.state.wagerGeneration ?? 0 })
    const active = new Set(doc.activeScores.map(({ playerId }) => playerId)), wagers: FinalWager[] = []
    for await (const doc of pages<WagerDoc>(this.access, query)) if (active.has(doc.wager.playerId)) wagers.push(doc.wager)
    return wagers
  }
  async submissions(ref: RoomRef, attempt: AttemptRef, request?: PageRequest, order: 'receipt' | 'priceEligible' | 'priceOverbid' = 'receipt'): Promise<Page<Submission>> {
    await this.reservation(ref)
    const invalid = await this.access.read<Invalidation>(ref.code, invalidationItemId(ref, attempt))
    if (invalid && invalid.reason !== 'void') return { items: [] }
    const query = this.query(ref, 'submission')
    query.filters.push({ field: 'attempt.clueId', value: attempt.clueId }, { field: 'attempt.attempt', value: attempt.attempt })
    query.order = [{ field: 'submission.elapsedMs' }, { field: 'submission.id' }]
    if (order !== 'receipt') {
      const clue = await this.clue(ref, attempt.clueId)
      const target = Number(clue?.config.correctPrice)
      if (!Number.isFinite(target)) throw new DomainError('conflict', 'Price clue has no valid target')
      query.filters.push({ field: 'price', op: order === 'priceEligible' ? '<=' : '>', value: target })
      query.order = [{ field: 'price', descending: order === 'priceEligible' }, { field: 'submission.playerId' }]
    }
    const result = await this.access.query<SubmissionDoc>(query, request)
    return { ...result, items: result.items.map(({ submission }) => submission) }
  }
  async submissionForPlayer(ref: RoomRef, attempt: AttemptRef, playerId: string): Promise<Submission | undefined> {
    await this.reservation(ref)
    const invalid = await this.access.read<Invalidation>(ref.code, invalidationItemId(ref, attempt))
    if (invalid && invalid.reason !== 'void') return undefined
    return (await this.access.read<SubmissionDoc>(ref.code, roomItemId(ref, `answer:${attemptKey(attempt)}:${playerId}`)))?.submission
  }
  prepareResult(ref: RoomRef, expectedRevision: string, resultId: string, chunkIndex: number, chunk: { entries: RoundOutcome[]; awards: ScoreAward[] }): Promise<void> {
    return this.serialize(ref.code, () => this.prepare(ref, expectedRevision, resultId, chunkIndex, chunk))
  }
  private async prepare(ref: RoomRef, expectedRevision: string, resultId: string, chunkIndex: number, chunk: { entries: RoundOutcome[]; awards: ScoreAward[] }): Promise<void> {
    const doc = await this.roomDoc(ref)
    if (etag(doc) !== expectedRevision) throw new DomainError('conflict', 'Room changed while scoring')
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunk.entries.length > 50 || chunk.awards.length > 50)
      throw new DomainError('conflict', 'Result chunk is too large')
    const id = roomItemId(ref, `chunk:${resultId}:${chunkIndex}`), payload = digest(chunk)
    const existing = await this.access.read<ResultChunk>(ref.code, id)
    if (existing) {
      if (existing.payload !== payload) throw new DomainError('conflict', 'Result chunk ID reused')
      return
    }
    const reservation = await this.reservation(ref)
    try {
      await this.access.batch(ref.code, [replace(reservation), { type: 'create', doc: document(ref.code, id, 'resultChunk', {
        generation: ref.generation, resultId, chunkIndex, ...chunk, payload,
      }) }])
    } catch (error) {
      const committed = await this.access.read<ResultChunk>(ref.code, id)
      if (committed?.payload === payload) return
      throw error
    }
  }
  async *chunks(ref: RoomRef, result: RoundResult): AsyncGenerator<{ entries: RoundOutcome[]; awards: ScoreAward[] }> {
    for (let index = 0; index < (result.stagedChunks ?? 0); index++) {
      const chunk = await this.access.read<ResultChunk>(ref.code, roomItemId(ref, `chunk:${result.id}:${index}`))
      if (!chunk) throw new DomainError('unavailable', 'Committed result is incomplete')
      yield chunk
    }
    yield result
  }
  async results(ref: RoomRef, attempt: AttemptRef, request?: PageRequest): Promise<Page<RoundOutcome>> {
    await this.reservation(ref)
    const descriptor = await this.access.read<ResultDoc>(ref.code, resultItemId(ref, attempt))
    if (!descriptor) return { items: [] }
    const invalid = await this.access.read<Invalidation>(ref.code, invalidationItemId(ref, attempt))
    if (invalid && invalid.reason !== 'void') return { items: [] }
    const start = request?.cursor ? parseCursor<{ resultId: string; offset: number }>(request.cursor) : { resultId: descriptor.result.id, offset: 0 }
    if (start.resultId !== descriptor.result.id || !Number.isSafeInteger(start.offset) || start.offset < 0)
      throw new DomainError('conflict', 'Invalid result cursor')
    const limit = pageLimit(request), items: RoundOutcome[] = []
    let index = 0, more = false
    for await (const chunk of this.chunks(ref, descriptor.result)) {
      for (const entry of chunk.entries) {
        if (index++ < start.offset) continue
        if (items.length === limit) { more = true; break }
        items.push(invalid ? { ...entry, correct: false, points: 0, evaluation: { ...(typeof entry.evaluation === 'object' && entry.evaluation ? entry.evaluation : {}), voided: true, special: invalid.special } } : entry)
      }
      if (more) break
    }
    return { items, ...(more ? { cursor: cursor({ resultId: descriptor.result.id, offset: start.offset + items.length }) } : {}) }
  }
  async appliedAwards(ref: RoomRef, attempt: AttemptRef): Promise<ScoreAward[]> {
    const room = await this.roomDoc(ref)
    if (await this.access.read(ref.code, invalidationItemId(ref, attempt))) return []
    const descriptor = await this.access.read<ResultDoc>(ref.code, resultItemId(ref, attempt))
    if (!descriptor) return []
    const totals = new Map(room.activeScores.map(({ playerId }) => [playerId, 0n]))
    for await (const chunk of this.chunks(ref, descriptor.result))
      for (const award of chunk.awards) if (totals.has(award.playerId) && award.source !== 'host_adjustment')
        totals.set(award.playerId, totals.get(award.playerId)! + BigInt(award.delta))
    return [...totals].filter(([, delta]) => delta !== 0n).map(([playerId, delta]): ScoreAward => {
      if (!safeScore(delta)) throw new DomainError('unavailable', 'Committed score reversal exceeds the safe integer range')
      return { playerId, clueId: attempt.clueId, delta: Number(delta), source: 'void', reason: '', actor: 'host' }
    })
  }
  async playerScore(ref: RoomRef, playerId: string): Promise<number> {
    let score = 0n
    const add = (delta: number) => {
      if (!Number.isSafeInteger(delta)) throw new DomainError('unavailable', 'History score delta is invalid')
      score += BigInt(delta)
    }
    for await (const descriptor of pages<ResultDoc>(this.access, this.query(ref, 'result'))) {
      const invalid = await this.access.read(ref.code, invalidationItemId(ref, descriptor.result.attempt))
      for await (const chunk of this.chunks(ref, descriptor.result))
        for (const award of chunk.awards)
          if (award.playerId === playerId && (!invalid || award.source === 'host_adjustment')) add(award.delta)
    }
    for await (const audit of pages<Audit>(this.access, this.query(ref, 'audit')))
      if (audit.award?.playerId === playerId) add(audit.award.delta)
    if (!safeScore(score)) throw new DomainError('unavailable', 'History score exceeds the safe integer range')
    return Number(score)
  }
  private async locator(pk: string, ref: RoomRef): Promise<void> {
    const current = await this.access.read<Locator>(pk, 'locator')
    if (current) {
      if (digest(current.ref) !== digest(ref)) throw new DomainError('conflict', 'Locator ID reused')
      return
    }
    try { await this.access.batch(pk, [{ type: 'create', doc: document(pk, 'locator', 'locator', { ref, generation: ref.generation }) }]) }
    catch (error) {
      const stored = await this.access.read<Locator>(pk, 'locator')
      if (stored && digest(stored.ref) === digest(ref)) return
      throw error
    }
  }
  commit(command: RoomCommit): Promise<LoadedRoom> {
    return this.serialize(command.ref.code, () => this.commitCommand(command))
  }
  private async commitCommand(command: RoomCommit): Promise<LoadedRoom> {
    const { ref, change } = command, payload = digest({ ...command, expectedRevision: undefined, at: undefined })
    const receiptId = roomItemId(ref, `receipt:${digest(command.operationId)}`)
    const receipt = async () => {
      const doc = await this.access.read<Receipt>(ref.code, receiptId)
      if (doc && doc.payload !== payload) throw new DomainError('conflict', 'Operation ID reused with different data')
      return doc
    }
    if (await receipt()) return this.load(ref)
    const current = await this.roomDoc(ref)
    if (etag(current) !== command.expectedRevision) throw new DomainError('conflict', 'Room state changed; refresh and try again')
    const next = clone(current), writes: Write[] = []
    const activeAttempt = { clueId: next.room.state.activeClueId, attempt: next.room.state.attempt ?? 0 }
    const checkAttempt = (attempt: AttemptRef) => {
      if (attempt.clueId !== activeAttempt.clueId || attempt.attempt !== activeAttempt.attempt)
        throw new DomainError('stale_attempt', 'This question has changed')
    }
    const addAwards = (awards: ScoreAward[]) => {
      for (const award of awards) {
        if (!Number.isSafeInteger(award.delta)) throw new DomainError('conflict', 'Invalid score delta')
        const score = next.activeScores.find(({ playerId }) => playerId === award.playerId)
        if (score) {
          if (!Number.isSafeInteger(score.score + award.delta)) throw new DomainError('conflict', 'Score exceeds the safe integer range')
          score.score += award.delta
        }
      }
    }
    switch (change.kind) {
      case 'none': break
      case 'join': {
        if (next.activeScores.length >= 50) throw new DomainError('room_full', 'This room is full')
        if (next.room.joiningLocked || ['finished', 'abandoned'].includes(next.room.status))
          throw new DomainError('conflict', 'This room is not accepting players')
        const player = change.player
        if (player.roomId !== ref.id) throw new DomainError('conflict', 'Player belongs to another room')
        const nicknameId = roomItemId(ref, `nickname:${digest(player.nickname.trim().toLocaleLowerCase())}`)
        if (await this.access.read(ref.code, nicknameId)) throw new DomainError('nickname_taken', 'That nickname is already in use')
        await this.locator(`player:${player.id}`, ref)
        writes.push({ type: 'create', doc: document(ref.code, roomItemId(ref, `player:${player.id}`), 'player', { generation: ref.generation, player }) },
          { type: 'create', doc: document(ref.code, nicknameId, 'nickname', { generation: ref.generation, playerId: player.id }) })
        next.activeScores.push({ playerId: player.id, nickname: player.nickname, teamName: player.teamName, score: 0, connected: player.connected })
        break
      }
      case 'connection':
      case 'kick': {
        const player = await this.access.read<PlayerDoc>(ref.code, roomItemId(ref, `player:${change.playerId}`))
        if (!player) throw new DomainError('not_found', 'Player not found')
        const connected = change.kind === 'connection' ? change.connected && !player.player.kicked : false
        writes.push(replace({ ...player, player: { ...player.player, connected, kicked: change.kind === 'kick' || player.player.kicked, lastSeenAt: command.at } }))
        if (change.kind === 'kick') next.activeScores = next.activeScores.filter(({ playerId }) => playerId !== change.playerId)
        else {
          const score = next.activeScores.find(({ playerId }) => playerId === change.playerId)
          if (score) score.connected = connected
        }
        break
      }
      case 'submission': {
        checkAttempt(change.attempt)
        if (change.window !== (next.room.state.window ?? 0)) throw new DomainError('stale_attempt', 'This answer window has changed')
        if (!next.activeScores.some(({ playerId }) => playerId === change.submission.playerId))
          throw new DomainError('conflict', 'Player is not active')
        const id = roomItemId(ref, `answer:${attemptKey(change.attempt)}:${change.submission.playerId}`)
        if (await this.access.read(ref.code, id)) throw new DomainError('duplicate_answer', 'You already answered this clue')
        writes.push({ type: 'create', doc: document(ref.code, id, 'submission', {
          generation: ref.generation, attempt: change.attempt, submission: change.submission, clue: change.clue,
          price: typeof change.submission.answer === 'number' ? change.submission.answer : null,
        }) })
        break
      }
      case 'wager': {
        checkAttempt(change.attempt)
        if (change.generation !== (next.room.state.wagerGeneration ?? 0)) throw new DomainError('stale_attempt', 'This wager has changed')
        const score = next.activeScores.find(({ playerId }) => playerId === change.wager.playerId)
        if (!score || !Number.isSafeInteger(change.wager.amount) || change.wager.amount < 0 || change.wager.amount > Math.max(0, score.score))
          throw new DomainError('conflict', 'Invalid final wager')
        const id = roomItemId(ref, `wager:${change.attempt.clueId}:${change.generation}:${change.wager.playerId}`)
        if (await this.access.read(ref.code, id)) throw new DomainError('duplicate_wager', 'Your final wager is already locked')
        writes.push({ type: 'create', doc: document(ref.code, id, 'wager', {
          generation: ref.generation, clueId: change.attempt.clueId, wagerGeneration: change.generation, wager: change.wager,
        }) })
        break
      }
      case 'settle': {
        checkAttempt(change.result.attempt)
        if (!Number.isSafeInteger(change.result.stagedChunks ?? 0) || (change.result.stagedChunks ?? 0) < 0 ||
          change.result.entries.length > 50 || change.result.awards.length > 50 || change.result.activeScores.length > 50)
          throw new DomainError('conflict', 'Result exceeds its bounded chunk or roster limits')
        const roster = next.activeScores.map(({ playerId }) => playerId).sort()
        if (digest(roster) !== digest(change.result.activeScores.map(({ playerId }) => playerId).sort()))
          throw new DomainError('conflict', 'Result active roster changed')
        const roundDeltas = new Map(next.activeScores.map(({ playerId }) => [playerId, 0n]))
        for await (const chunk of this.chunks(ref, change.result)) {
          addAwards(chunk.awards)
          for (const award of chunk.awards) if (award.source !== 'host_adjustment' && roundDeltas.has(award.playerId))
            roundDeltas.set(award.playerId, roundDeltas.get(award.playerId)! + BigInt(award.delta))
          const inactive = new Set(chunk.awards.filter((award) => !next.activeScores.some(({ playerId }) => playerId === award.playerId))
            .map(({ playerId }) => playerId))
          for (const playerId of inactive) {
            let delta = 0n
            for await (const part of this.chunks(ref, change.result))
              for (const award of part.awards) if (award.playerId === playerId) {
                if (!Number.isSafeInteger(award.delta)) throw new DomainError('conflict', 'Invalid score delta')
                delta += BigInt(award.delta)
              }
            if (!safeScore(BigInt(await this.playerScore(ref, playerId)) + delta))
              throw new DomainError('conflict', 'Score exceeds the safe integer range')
          }
          if ([...roundDeltas.values()].some((delta) => !safeScore(delta)))
            throw new DomainError('conflict', 'Round score reversal exceeds the safe integer range')
        }
        for (const score of change.result.activeScores)
          if (score.score !== next.activeScores.find(({ playerId }) => playerId === score.playerId)?.score)
            throw new DomainError('conflict', 'Result score summary does not match its awards')
        writes.push({ type: 'create', doc: document(ref.code, resultItemId(ref, change.result.attempt), 'result', {
          generation: ref.generation, result: change.result,
        }) })
        break
      }
      case 'invalidate': {
        checkAttempt(change.attempt)
        const applied = await this.appliedAwards(ref, change.attempt)
        const expected = applied.map(({ playerId, delta }) => ({ playerId, delta: -delta })).sort((a, b) => a.playerId.localeCompare(b.playerId))
        const supplied = change.awards.filter(({ delta }) => delta !== 0).map(({ playerId, delta }) => ({ playerId, delta })).sort((a, b) => a.playerId.localeCompare(b.playerId))
        if (digest(expected) !== digest(supplied)) throw new DomainError('conflict', 'Score reversal does not match the committed result')
        addAwards(change.awards)
        const id = invalidationItemId(ref, change.attempt), prior = await this.access.read<Invalidation>(ref.code, id)
        const invalid = document(ref.code, id, 'invalidation', { generation: ref.generation, attempt: change.attempt, reason: change.reason, special: change.special ?? null })
        writes.push(prior ? { type: 'replace', doc: invalid, etag: etag(prior) } : { type: 'create', doc: invalid })
        writes.push({ type: 'create', doc: document(ref.code, roomItemId(ref, `audit:${digest(command.operationId)}`), 'audit', { generation: ref.generation, change, at: command.at }) })
        if (change.reason === 'goBack') {
          const clearId = roomItemId(ref, `wagerClear:${change.attempt.clueId}:${current.room.state.wagerGeneration ?? 0}`)
          if (!await this.access.read(ref.code, clearId))
            writes.push({ type: 'create', doc: document(ref.code, clearId, 'wagerClear', { generation: ref.generation }) })
        }
        break
      }
      case 'adjustment':
        addAwards([change.award])
        if (!await this.loadPlayer(ref, change.award.playerId)) throw new DomainError('not_found', 'Player not found')
        if (!next.activeScores.some(({ playerId }) => playerId === change.award.playerId) &&
          !Number.isSafeInteger(await this.playerScore(ref, change.award.playerId) + change.award.delta))
          throw new DomainError('conflict', 'Score exceeds the safe integer range')
        writes.push({ type: 'create', doc: document(ref.code, roomItemId(ref, `audit:${digest(command.operationId)}`), 'audit', { generation: ref.generation, award: change.award, at: command.at }) })
        break
    }
    if (command.state) {
      if (command.state.nextStateVersion <= current.room.stateVersion) throw new DomainError('conflict', 'Invalid state version')
      next.room = { ...next.room, state: command.state.value, status: command.state.status,
        stateVersion: command.state.nextStateVersion, joiningLocked: command.state.joiningLocked,
        completedAt: ['finished', 'abandoned'].includes(command.state.status) ? command.at : next.room.completedAt }
    }
    if (next.room.state.specialVotes) {
      const active = new Set(next.activeScores.map(({ playerId }) => playerId))
      next.room.state.specialVotes = Object.fromEntries(Object.entries(next.room.state.specialVotes)
        .filter(([voter, target]) => active.has(voter) && active.has(target)))
    }
    if (command.state) writes.push({ type: 'create', doc: document(ref.code, roomItemId(ref, `snapshot:${command.state.nextStateVersion}`), 'snapshot', {
      generation: ref.generation, state: next.room.state, at: command.at,
    }) })
    next.room.updatedAt = command.at
    writes.push(replace(next), { type: 'create', doc: document(ref.code, receiptId, 'receipt', { generation: ref.generation, payload }) })
    try { await this.access.batch(ref.code, writes) }
    catch (error) {
      if (await receipt()) return this.load(ref)
      if (conflict(error)) throw new DomainError('conflict', 'Room changed during commit; refresh and try again')
      throw error
    }
    return this.load(ref)
  }
  private frozenClues(ref: RoomRef, pack: PackDocument): Document[] {
    return pack.categories.flatMap((category) => category.clues.map((source) => {
      if (!['music_multiple_choice', 'music_free_text', 'price_slider'].includes(source.type) ||
        typeof source.config !== 'object' || source.config === null || Array.isArray(source.config))
        throw new DomainError('conflict', 'Pack contains an unsupported clue')
      const clue: GameClue = { ...source, type: source.type as GameClue['type'], categoryId: category.id, config: source.config as Record<string, unknown> }
      const board: BoardEntry = { categoryId: category.id, categoryTitle: category.title, categoryPosition: category.position,
        clueId: clue.id, boardValue: clue.boardValue, cluePosition: source.position, clueType: clue.type }
      return document(ref.code, roomItemId(ref, `clue:${clue.id}`), 'frozenClue', { generation: ref.generation, clue, board })
    }))
  }
  create(packId: string, settings: GameSettings, hostTokenHash: string, codeLength: number, operationId: string): Promise<LoadedRoom> {
    return this.serialize(`creation:${digest(operationId)}`, () => this.createRoom(packId, settings, hostTokenHash, codeLength, operationId))
  }
  private async createRoom(packId: string, settings: GameSettings, hostTokenHash: string, codeLength: number, operationId: string): Promise<LoadedRoom> {
    const payload = digest({ packId, settings, hostTokenHash })
    const creationPartition = `creation:${digest(operationId)}`
    const receipt = await this.access.read<CreationReceipt>(creationPartition, 'receipt')
    if (receipt) {
      if (receipt.payload !== payload) throw new DomainError('conflict', 'Room creation operation ID reused')
      const gate = await this.access.read<Reservation>(receipt.ref.code, 'reservation')
      if (gate?.status === 'ready' && gate.ref.generation === receipt.ref.generation) return this.load(receipt.ref)
      throw new DomainError('conflict', 'Room creation operation is interrupted or was deleted; use a new operation ID')
    }
    const id = digest({ kind: 'room', operationId }), existing = await this.resolveId(id)
    if (existing) {
      const current = await this.load(existing)
      if (current.room.packId !== packId || current.room.hostTokenHash !== hostTokenHash || digest(current.room.settings) !== digest(settings))
        throw new DomainError('conflict', 'Room creation operation ID reused')
      return current
    }
    const generation = createId()
    let reserved: Reservation | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = this.roomCode(codeLength).toUpperCase(), prior = await this.access.read<Reservation>(code, 'reservation')
      if (prior && prior.status !== 'free') continue
      const ref = { id, code, generation }
      const next = document(code, 'reservation', 'reservation', { ref, status: 'staging' as const, packId, operationId })
      try {
        await this.access.batch(code, [prior ? { type: 'replace', doc: next, etag: etag(prior) } : { type: 'create', doc: next }])
        reserved = (await this.access.read<Reservation>(code, 'reservation'))!
        break
      } catch (error) {
        const committed = await this.access.read<Reservation>(code, 'reservation')
        if (committed?.ref.id === id && committed.ref.generation === generation) { reserved = committed; break }
        if (!conflict(error)) throw error
      }
    }
    if (!reserved) throw new DomainError('conflict', 'Unable to allocate a room code')
    const ref = reserved.ref
    return this.serialize(ref.code, async () => {
      const allocated = await this.access.read<Reservation>(ref.code, 'reservation')
      if (allocated?.status !== 'staging' || allocated.ref.generation !== ref.generation)
        throw new DomainError('conflict', 'Room creation was interrupted by deletion')
      try { await this.access.batch(creationPartition, [{ type: 'create', doc: document(creationPartition, 'receipt', 'roomCreationReceipt', { ref, payload }) }]) }
      catch (error) {
        const committed = await this.access.read<CreationReceipt>(creationPartition, 'receipt')
        if (!committed || committed.payload !== payload || committed.ref.generation !== ref.generation) throw error
      }
      await this.locator(`id:${id}`, ref)
      const pack = await this.packs.pin(ref, packId)
      if ((settings.specials?.length ?? 0) > pack.categories.flatMap(({ clues }) => clues).filter((clue) => !clue.finalQuestion).length)
        throw new DomainError('conflict', 'Pack needs more ordinary clues for the selected specials')
      const fenced: CosmosAccess = {
        read: this.access.read.bind(this.access), query: this.access.query.bind(this.access),
        batch: async (pk, writes) => {
          const gate = await this.access.read<Reservation>(pk, 'reservation')
          if (gate?.status !== 'staging' || gate.ref.generation !== ref.generation)
            throw new DomainError('conflict', 'Room creation was interrupted by deletion')
          await this.access.batch(pk, [replace(gate), ...writes])
        },
      }
      await writeChunks(fenced, ref.code, this.frozenClues(ref, pack))
      const at = now(), room: RoomRecord = {
        ref, revision: '', id, code: ref.code, packId, hostTokenHash, settings, status: 'lobby',
        state: { phase: 'LOBBY', usedClueIds: [], specialAssignments: {}, attempt: 0, window: 0, wagerGeneration: 0 },
        stateVersion: 0, joiningLocked: false, createdAt: at, updatedAt: at, completedAt: null,
      }
      try {
        await this.access.batch(ref.code, [
          replace({ ...(await this.access.read<Reservation>(ref.code, 'reservation'))!, status: 'ready' }),
          { type: 'create', doc: document(ref.code, roomItemId(ref, 'room'), 'room', {
            generation, room, activeScores: [], packTitle: pack.title, packRevision: pack.revision, deleting: false,
          }) },
          { type: 'create', doc: document(ref.code, roomItemId(ref, 'created'), 'receipt', { generation, payload }) },
        ])
      } catch (error) {
        const completed = await this.resolveId(id)
        if (completed) return this.load(completed)
        if (conflict(error)) throw new DomainError('conflict', 'Room creation was interrupted by deletion')
        throw error
      }
      return this.load(ref)
    })
  }
  async interrupted(request?: PageRequest): Promise<Page<RoomRef>> {
    const result = await this.access.query<RoomDoc>({ filters: [
      { field: 'kind', value: 'room' }, { field: 'room.status', value: 'active' },
      { field: 'deleting', value: false },
    ] }, request)
    return { ...result, items: result.items.map(({ room }) => room.ref) }
  }
  async forPack(packId: string, request?: PageRequest): Promise<Page<RoomRef>> {
    const result = await this.access.query<Reservation>({ filters: [
      { field: 'kind', value: 'reservation' }, { field: 'packId', value: packId },
      { field: 'status', op: 'IN', value: ['ready', 'staging', 'deleting'] },
    ] }, request)
    return { ...result, items: result.items.map(({ ref }) => ref) }
  }
  async disconnectAll(): Promise<void> {
    for await (const room of pages<RoomDoc>(this.access, { filters: [{ field: 'kind', value: 'room' }] })) {
      if (!await this.resolveId(room.room.id)) continue
      for (const player of await this.listPlayers(room.room.ref)) if (player.connected) {
        const loaded = await this.load(room.room.ref)
        await this.commit({ ref: loaded.ref, expectedRevision: loaded.revision, operationId: createId(), at: now(),
          change: { kind: 'connection', playerId: player.id, connected: false } })
      }
    }
  }
  delete(ref: RoomRef, completedOnly = true): Promise<'deleted' | 'not_found' | 'active'> {
    return this.serialize(ref.code, () => this.deleteGeneration(ref, completedOnly))
  }
  async deleteId(id: string): Promise<'deleted' | 'not_found' | 'active'> {
    const locator = await this.access.read<Locator>(`id:${id}`, 'locator')
    return locator ? this.delete(locator.ref) : 'not_found'
  }
  private async deleteGeneration(ref: RoomRef, completedOnly: boolean): Promise<'deleted' | 'not_found' | 'active'> {
    const current = await this.access.read<Reservation>(ref.code, 'reservation')
    if (!current || current.ref.generation !== ref.generation || current.ref.id !== ref.id || current.status === 'free') return 'not_found'
    let reservation = current
    if (reservation.status !== 'deleting') {
      const room = await this.access.read<RoomDoc>(ref.code, roomItemId(ref, 'room'))
      if (completedOnly && room && !['finished', 'abandoned'].includes(room.room.status)) return 'active'
      // The room CAS fences commands that loaded before the reservation tombstone.
      const writes: Write[] = [replace({ ...reservation, status: 'deleting' })]
      if (room) writes.push(replace({ ...room, deleting: true }))
      await this.access.batch(ref.code, writes)
      reservation = (await this.access.read<Reservation>(ref.code, 'reservation'))!
    }
    while (true) {
      const result = await this.access.query<Document>({ pk: ref.code, filters: [
        { field: 'generation', value: ref.generation },
      ] }, { limit: 90 })
      if (!result.items.length) break
      await this.access.batch(ref.code, result.items.map(remove))
    }
    // Locators are generation-owned but reside in point-routing partitions.
    while (true) {
      const result = await this.access.query<Locator>({ filters: [
        { field: 'kind', value: 'locator' }, { field: 'generation', value: ref.generation },
      ] }, { limit: 90 })
      if (!result.items.length) break
      for (const locator of result.items) await this.access.batch(locator.pk, [remove(locator)])
    }
    await this.packs.releasePin(ref)
    // Reuse is allowed only after every owned document and media claim was removed.
    await this.access.batch(ref.code, [replace({ ...reservation, status: 'free' })])
    return 'deleted'
  }
  async recover(): Promise<void> {
    for await (const reservation of pages<Reservation>(this.access, { filters: [
      { field: 'kind', value: 'reservation' }, { field: 'status', op: 'IN', value: ['staging', 'deleting'] },
    ] })) await this.delete(reservation.ref, false)
    // Chunk documents are invisible until a result descriptor is committed.
    for await (const chunk of pages<ResultChunk>(this.access, { filters: [{ field: 'kind', value: 'resultChunk' }] })) {
      const descriptor = await this.access.query<ResultDoc>({ pk: chunk.pk, filters: [
        { field: 'kind', value: 'result' }, { field: 'generation', value: chunk.generation }, { field: 'result.id', value: chunk.resultId },
      ] }, { limit: 1 })
      if (!descriptor.items.length) await this.access.batch(chunk.pk, [remove(chunk)])
    }
  }
}
