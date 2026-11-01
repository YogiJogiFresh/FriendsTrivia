import type { GameSettings, PlayerRecord, PlayerScore, RoomRecord, RoomState } from './game/types.js'
import type { GifProvider } from './gifs.js'

export type Revision = string
export interface PageRequest { cursor?: string; limit?: number }
export interface Page<T> { items: T[]; cursor?: string }
export interface RoomRef { id: string; code: string; generation: string }
export interface AttemptRef { clueId: string; attempt: number }
export interface AnswerWindow { attempt: AttemptRef; window: number }
export interface LoadedRoom { ref: RoomRef; room: RoomRecord; revision: Revision; activeScores: PlayerScore[] }
export type DomainErrorCode = 'not_found' | 'conflict' | 'duplicate_answer' | 'duplicate_wager' | 'nickname_taken' | 'room_full' | 'stale_attempt' | 'media_referenced' | 'quota_exceeded' | 'unavailable' | 'unsupported_version'
export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) { super(message) }
}
export interface MediaAsset {
  id: string; relativePath: string; originalName: string; mimeType: string
  sizeBytes: number; durationSeconds: number | null; createdAt: string
}
export interface MediaInput { relativePath: string; originalName: string; mimeType: string; sizeBytes: number }
export type MediaOwner =
  | { kind: 'pack'; id: string; revision: string }
  | { kind: 'room'; id: string; generation: string }
  | { kind: 'operation'; id: string }
export interface UploadReservation { id: string; operationId: string; ownedKeys: string[]; reservedBytes: number }
export interface MediaDeletion { id: string; operationId: string; asset: MediaAsset }
export type MediaCleanup =
  | { kind: 'upload'; reservation: UploadReservation }
  | { kind: 'delete'; ticket: MediaDeletion }
  | { kind: 'operation'; owner: { kind: 'operation'; id: string }; ownedKeys: string[]; published?: boolean }
export interface MediaStore {
  list(page?: PageRequest): Promise<Page<MediaAsset>>
  get(id: string): Promise<MediaAsset | undefined>
  findByPath(path: string): Promise<MediaAsset | undefined>
  createIfMissing(input: MediaInput): Promise<MediaAsset>
  reserveUpload(operationId: string, ownedKeys: string[]): Promise<UploadReservation>
  growReservation(reservation: UploadReservation, totalBytes: number): Promise<UploadReservation>
  commitUploaded(reservation: UploadReservation, input: MediaInput, actualBytes: number, owner?: MediaOwner): Promise<MediaAsset>
  abortUpload(reservation: UploadReservation, deletedKeys: string[]): Promise<void>
  claim(owner: MediaOwner, mediaIds: string[]): Promise<void>
  releaseClaims(owner: MediaOwner, page?: PageRequest): Promise<{ done: boolean }>
  completeOperation(owner: { kind: 'operation'; id: string }): Promise<void>
  beginDelete(id: string, operationId: string): Promise<MediaDeletion | undefined>
  finishDelete(ticket: MediaDeletion, confirmedAbsent: boolean): Promise<void>
  pendingCleanup(page?: PageRequest): Promise<Page<MediaCleanup>>
}
export interface PackSummary {
  id: string; title: string; description: string; status: 'draft' | 'ready' | 'archived'
  categoryCount: number; clueCount: number; ordinaryClueCount: number; createdAt: string; updatedAt: string
}
export interface PackInput {
  title: string; description?: string; status?: PackSummary['status']; defaultSettings?: unknown
  categories: Array<{ id?: string; title: string; clues: Array<{
    id?: string; type: string; boardValue: number; prompt: string; timerSeconds?: number
    mediaAssetId?: string | null; revealMediaAssetId?: string | null; finalQuestion?: boolean; config: unknown
  }> }>
}
export interface PackDocument {
  id: string; title: string; description: string; status: PackSummary['status']; revision: Revision
  defaultSettings: unknown; createdAt: string; updatedAt: string
  categories: Array<{ id: string; title: string; position: number; clues: Array<{
    id: string; type: string; boardValue: number; position: number; prompt: string; timerSeconds: number
    mediaAssetId: string | null; revealMediaAssetId: string | null; finalQuestion: boolean; config: unknown
  }> }>
}
export interface PackStore {
  list(includeArchived?: boolean, page?: PageRequest): Promise<Page<PackSummary>>
  get(id: string): Promise<PackDocument | undefined>
  create(input: { title: string; description?: string }, operationId: string): Promise<PackDocument>
  replace(id: string, input: PackInput, expectedRevision: Revision, operationId: string, importOwner?: { kind: 'operation'; id: string }): Promise<PackDocument | undefined>
  archive(id: string): Promise<boolean>
  remove(id: string, operationId: string): Promise<'deleted' | 'not_found'>
}
export interface GameClue {
  id: string; categoryId: string; type: 'music_multiple_choice' | 'music_free_text' | 'price_slider'
  boardValue: number; prompt: string; timerSeconds: number; config: Record<string, unknown>
  mediaAssetId: string | null; revealMediaAssetId: string | null; finalQuestion: boolean
}
export interface BoardEntry {
  categoryId: string; categoryTitle: string; categoryPosition: number; clueId: string
  boardValue: number; cluePosition: number; clueType: GameClue['type']
}
export interface Submission {
  id: string; playerId: string; answer: unknown; elapsedMs: number; receivedAt: string
}
export interface FinalWager { playerId: string; amount: number }
export interface RoundOutcome {
  submissionId: string; playerId: string; answer: unknown; elapsedMs: number; receivedAt: string
  correct: boolean; rank?: number; points: number; evaluation: unknown; synthetic: boolean
}
export interface ScoreAward {
  playerId: string; clueId?: string; delta: number; source: 'music' | 'price' | 'host_adjustment' | 'void'
  reason: string; actor: string
}
export interface RoundResult {
  id: string; attempt: AttemptRef; clue: GameClue; entries: RoundOutcome[]; awards: ScoreAward[]
  activeScores: PlayerScore[]
  stagedChunks?: number
}
export type RoomChange =
  | { kind: 'none' }
  | { kind: 'join'; player: PlayerRecord }
  | { kind: 'connection'; playerId: string; connected: boolean }
  | { kind: 'kick'; playerId: string }
  | { kind: 'submission'; attempt: AttemptRef; window: number; submission: Submission; clue: GameClue }
  | { kind: 'wager'; attempt: AttemptRef; generation: number; wager: FinalWager }
  | { kind: 'settle'; result: RoundResult }
  | { kind: 'invalidate'; attempt: AttemptRef; reason: 'reset' | 'goBack' | 'void'; awards: ScoreAward[]; special?: string }
  | { kind: 'adjustment'; award: ScoreAward }
export interface RoomCommit {
  ref: RoomRef; expectedRevision: Revision; operationId: string; at: string
  state?: { value: RoomState; status: RoomRecord['status']; nextStateVersion: number; joiningLocked: boolean }
  change: RoomChange
}
export interface RoomStore {
  resolveCode(code: string): Promise<RoomRef | undefined>
  resolveId(id: string): Promise<RoomRef | undefined>
  load(ref: RoomRef): Promise<LoadedRoom>
  loadPlayer(ref: RoomRef, id: string): Promise<PlayerRecord | undefined>
  findPlayer(id: string): Promise<PlayerRecord | undefined>
  listPlayers(ref: RoomRef): Promise<PlayerRecord[]>
  board(ref: RoomRef): Promise<BoardEntry[]>
  clue(ref: RoomRef, id: string): Promise<GameClue | undefined>
  finalClueId(ref: RoomRef): Promise<string | undefined>
  wagers(ref: RoomRef, attempt: AttemptRef): Promise<FinalWager[]>
  submissions(ref: RoomRef, attempt: AttemptRef, page?: PageRequest, order?: 'receipt' | 'priceEligible' | 'priceOverbid'): Promise<Page<Submission>>
  submissionForPlayer(ref: RoomRef, attempt: AttemptRef, playerId: string): Promise<Submission | undefined>
  prepareResult(ref: RoomRef, expectedRevision: Revision, resultId: string, chunkIndex: number, chunk: { entries: RoundOutcome[]; awards: ScoreAward[] }): Promise<void>
  results(ref: RoomRef, attempt: AttemptRef, page?: PageRequest): Promise<Page<RoundOutcome>>
  appliedAwards(ref: RoomRef, attempt: AttemptRef): Promise<ScoreAward[]>
  commit(command: RoomCommit): Promise<LoadedRoom>
  create(packId: string, settings: GameSettings, hostTokenHash: string, codeLength: number, operationId: string): Promise<LoadedRoom>
  interrupted(page?: PageRequest): Promise<Page<RoomRef>>
  forPack(packId: string, page?: PageRequest): Promise<Page<RoomRef>>
  disconnectAll(): Promise<void>
}
export type HistoryRow = Record<string, string | number | null>
export interface HistoryStore {
  list(page?: PageRequest): Promise<Page<HistoryRow>>
  header(id: string): Promise<HistoryRow | undefined>
  players(id: string, page?: PageRequest): Promise<Page<HistoryRow>>
  submissions(id: string, page?: PageRequest): Promise<Page<HistoryRow>>
  exportRows(id: string, page?: PageRequest): Promise<Page<HistoryRow>>
  removeCompleted(id: string): Promise<'deleted' | 'not_found' | 'active'>
  removeAllCompleted(): Promise<number>
}
export interface SettingsStore {
  gifKey(provider: GifProvider): Promise<string | undefined>
  setGifKey(provider: GifProvider, key: string): Promise<void>
}
export interface DomainStore {
  mode: 'local' | 'cloud'; packs: PackStore; rooms: RoomStore; history: HistoryStore; media: MediaStore; settings: SettingsStore
  recover(): Promise<void>; close(): Promise<void>
}
