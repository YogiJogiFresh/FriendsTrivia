import { DomainError, type HistoryRow, type HistoryStore, type Page, type PageRequest,
  type RoomRef, type RoundOutcome } from '../domain.js'
import { CosmosRooms, invalidationItemId, resultItemId, type Invalidation,
  roomItemId, type ClueDoc, type PlayerDoc, type ResultDoc, type RoomDoc, type SubmissionDoc } from './cosmosRooms.js'
import { pageLimit, pages } from './cosmosIo.js'

export class CosmosHistory implements HistoryStore {
  constructor(private readonly rooms: CosmosRooms) {}
  async list(request?: PageRequest): Promise<Page<HistoryRow>> {
    const result = await this.rooms.access.query<RoomDoc>({ filters: [
      { field: 'kind', value: 'room' }, { field: 'room.status', op: 'IN', value: ['finished', 'abandoned'] },
      { field: 'deleting', value: false },
    ], order: [{ field: 'room.updatedAt', descending: true }] }, request)
    const items: HistoryRow[] = []
    for (const doc of result.items) if (await this.rooms.resolveId(doc.room.id)) {
      const { room } = doc
      items.push({ id: room.id, code: room.code, packTitle: doc.packTitle, status: room.status,
        createdAt: room.createdAt, completedAt: room.completedAt, playerCount: doc.activeScores.length })
    }
    return { ...result, items }
  }
  async header(id: string): Promise<HistoryRow | undefined> {
    const ref = await this.rooms.resolveId(id)
    if (!ref) return undefined
    const doc = await this.rooms.roomDoc(ref), { room } = doc
    return { id: room.id, code: room.code, packTitle: doc.packTitle, status: room.status,
      settings: JSON.stringify(room.settings), createdAt: room.createdAt, completedAt: room.completedAt }
  }
  async players(id: string, request?: PageRequest): Promise<Page<HistoryRow>> {
    const ref = await this.rooms.resolveId(id)
    if (!ref) return { items: [] }
    let after: { score: number; id: string; roomId: string } | undefined
    if (request?.cursor) {
      try {
        after = JSON.parse(Buffer.from(request.cursor, 'base64url').toString()) as typeof after
        if (!after || !Number.isSafeInteger(after.score) || typeof after.id !== 'string' || after.roomId !== id) throw new Error()
      } catch { throw new DomainError('conflict', 'Invalid history player cursor') }
    }
    const limit = pageLimit(request), ranked: Array<{ row: HistoryRow; score: number; id: string }> = []
    // shortcut: ranking scans immutable awards with bounded memory; add projections only if measured RUs require them.
    for await (const { player } of pages<PlayerDoc>(this.rooms.access, this.rooms.query(ref, 'player'))) {
      const score = await this.rooms.playerScore(ref, player.id)
      if (after && (score > after.score || (score === after.score && player.id <= after.id))) continue
      ranked.push({ row: { id: player.id, nickname: player.nickname, teamName: player.teamName, score }, score, id: player.id })
      ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      if (ranked.length > limit + 1) ranked.pop()
    }
    const more = ranked.length > limit
    if (more) ranked.pop()
    const last = ranked.at(-1)
    return { items: ranked.map(({ row }) => row), ...(more && last ? {
      cursor: Buffer.from(JSON.stringify({ score: last.score, id: last.id, roomId: id })).toString('base64url'),
    } : {}) }
  }
  private async row(ref: RoomRef, clueId: string, entry: RoundOutcome): Promise<HistoryRow> {
    const frozen = await this.rooms.access.read<ClueDoc>(ref.code, roomItemId(ref, `clue:${clueId}`))
    if (!frozen) throw new DomainError('unavailable', 'Frozen history clue is missing')
    const { clue, board: { categoryTitle } } = frozen
    return { playerId: entry.playerId, clueId, categoryTitle, cluePrompt: clue.prompt, clueType: clue.type,
      answer: JSON.stringify(entry.answer), elapsedMs: entry.elapsedMs, correct: entry.correct ? 1 : 0,
      rank: entry.rank ?? null, pointsAwarded: entry.points, evaluation: entry.evaluation === null ? null : JSON.stringify(entry.evaluation) }
  }
  private async *rows(ref: RoomRef): AsyncGenerator<HistoryRow> {
    const query = this.rooms.query(ref, 'result')
    query.order = [{ field: 'result.attempt.attempt' }]
    for await (const descriptor of pages<ResultDoc>(this.rooms.access, query)) {
      let cursor: string | undefined
      do {
        const result = await this.rooms.results(ref, descriptor.result.attempt, { limit: 100, ...(cursor ? { cursor } : {}) })
        for (const entry of result.items) yield await this.row(ref, descriptor.result.attempt.clueId, entry)
        cursor = result.cursor
      } while (cursor)
    }
    const submissions = this.rooms.query(ref, 'submission')
    submissions.order = [{ field: 'submission.receivedAt' }]
    for await (const doc of pages<SubmissionDoc>(this.rooms.access, submissions)) {
      if (await this.rooms.access.read(ref.code, resultItemId(ref, doc.attempt))) continue
      const invalid = await this.rooms.access.read<Invalidation>(ref.code, invalidationItemId(ref, doc.attempt))
      if (invalid && invalid.reason !== 'void') continue
      const entry: RoundOutcome = { ...doc.submission, submissionId: doc.submission.id,
        correct: false, points: 0, evaluation: invalid ? { voided: true, special: invalid.special } : null, synthetic: false }
      const row = await this.row(ref, doc.attempt.clueId, entry)
      yield invalid ? row : { ...row, correct: null }
    }
  }
  private async detail(id: string, request: PageRequest | undefined, exporting: boolean): Promise<Page<HistoryRow>> {
    const ref = await this.rooms.resolveId(id)
    if (!ref) return { items: [] }
    const offset = Number(request?.cursor ?? 0), limit = pageLimit(request)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DomainError('conflict', 'Invalid history cursor')
    const items: HistoryRow[] = []
    let index = 0, more = false
    // Replaying a cursor scans bounded pages; it never materializes the room history.
    for await (const row of this.rows(ref)) {
      if (index++ < offset) continue
      if (items.length === limit) { more = true; break }
      if (!exporting) { items.push(row); continue }
      const player = await this.rooms.loadPlayer(ref, String(row.playerId))
      if (!player) throw new DomainError('unavailable', 'History player is missing')
      items.push({ nickname: player.nickname, team: player.teamName, category: row.categoryTitle ?? null,
        prompt: row.cluePrompt ?? null, type: row.clueType ?? null, answer_json: row.answer ?? null,
        elapsed_ms: row.elapsedMs ?? null, correct: row.correct ?? null, rank: row.rank ?? null,
        points_awarded: row.pointsAwarded ?? null, evaluation_json: row.evaluation ?? null })
    }
    return { items, ...(more ? { cursor: String(offset + items.length) } : {}) }
  }
  submissions(id: string, request?: PageRequest): Promise<Page<HistoryRow>> { return this.detail(id, request, false) }
  exportRows(id: string, request?: PageRequest): Promise<Page<HistoryRow>> { return this.detail(id, request, true) }
  async removeCompleted(id: string) {
    return this.rooms.deleteId(id)
  }
  async removeAllCompleted(): Promise<number> {
    let count = 0
    while (true) {
      const result = await this.list({ limit: 100 })
      if (!result.items.length) return count
      for (const row of result.items) if (await this.removeCompleted(String(row.id)) === 'deleted') count++
    }
  }
}
