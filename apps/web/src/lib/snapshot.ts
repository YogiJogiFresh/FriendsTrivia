/**
 * Converts the raw JSON snapshots emitted by the server
 * (`GameEngine.publicSnapshot` / `hostSnapshot` in
 * `apps/server/src/game/engine.ts`, delivered via the `room:snapshot` /
 * `host:snapshot` socket events or `GET /api/rooms/:code`) into the UI's
 * `data/types.ts` shapes. This is the one place that needs to change if the
 * server's snapshot shape changes — components never see the raw shape.
 */
import type { ServerClueType } from './apiClient'
import type {
  Category,
  Clue,
  ClueOption,
  GamePhase,
  GameState,
  LeaderboardEntry,
  Player,
  PriceResultEntry,
  RevealGif,
  RoomSummary,
  SpecialType,
} from '../data/types'

export interface RawBoardRow {
  categoryId: string
  categoryTitle: string
  categoryPosition: number
  clueId: string
  boardValue: number
  cluePosition: number
  clueType: ServerClueType
}

export interface RawPriceConfig {
  min: number
  max: number
  step: number
  prefix: string
}

export interface RawActiveClue {
  id: string
  categoryId: string
  type: ServerClueType
  boardValue: number
  prompt: string
  timerSeconds: number
  special?: SpecialType
  mediaUrl?: string
  revealMediaUrl?: string
  revealGif?: RevealGif
  choices?: string[]
  price?: RawPriceConfig
  answer?: unknown
}

export interface RawPlayerScore {
  playerId: string
  nickname: string
  teamName: string | null
  score: number
  connected: boolean
}

export interface RawResult {
  playerId: string
  answer: string
  correct: number
  rank: number | null
  pointsAwarded: number
  evaluation: string
}

export interface RawSubmission {
  playerId: string
  elapsedMs: number
  receivedAt: string
}

export interface RawSnapshot {
  code: string
  joinUrl: string
  phase: GamePhase
  stateVersion: number
  joiningLocked: boolean
  teams?: string[]
  deadline?: string
  finalRound?: boolean
  hasFinalQuestion?: boolean
  wageredPlayerIds?: string[]
  activeClue?: RawActiveClue
  usedClueIds: string[]
  board: RawBoardRow[]
  players: RawPlayerScore[]
  results?: RawResult[]
  /** Present only on the host-authenticated `host:snapshot` channel. */
  submissions?: RawSubmission[]
}

const ACCENT_TOKENS = [
  '--category-accent-1',
  '--category-accent-2',
  '--category-accent-3',
  '--category-accent-4',
  '--category-accent-5',
  '--category-accent-6',
]

function toUiClueType(type: ServerClueType): Clue['type'] {
  switch (type) {
    case 'music_multiple_choice':
      return 'music-multiple-choice'
    case 'music_free_text':
      return 'music-free-text'
    case 'price_slider':
    default:
      return 'price-slider'
  }
}

function optionsFromChoices(choices: string[] | undefined): ClueOption[] {
  return (choices ?? []).map((label, index) => ({ id: `choice-${index}`, label }))
}

function formatRevealedAnswer(active: RawActiveClue | undefined): string | undefined {
  if (!active || active.answer === undefined || active.answer === null) return undefined
  if (active.type === 'price_slider') {
    const prefix = active.price?.prefix ?? '$'
    return `${prefix}${Number(active.answer).toLocaleString()}`
  }
  if (Array.isArray(active.answer)) return active.answer.join(' / ')
  return String(active.answer)
}

export function categoriesFromBoard(board: RawBoardRow[]): Category[] {
  const byId = new Map<string, Category & { position: number }>()
  for (const row of board) {
    let category = byId.get(row.categoryId)
    if (!category) {
      category = {
        id: row.categoryId,
        title: row.categoryTitle,
        accentToken: ACCENT_TOKENS[byId.size % ACCENT_TOKENS.length] ?? '--category-accent-1',
        clueIds: [],
        position: row.categoryPosition,
      }
      byId.set(row.categoryId, category)
    }
    category.clueIds.push(row.clueId)
  }
  return [...byId.values()]
    .sort((a, b) => a.position - b.position)
    .map(({ id, title, accentToken, clueIds }) => ({ id, title, accentToken, clueIds }))
}

export function cluesFromSnapshot(snapshot: Pick<RawSnapshot, 'board' | 'usedClueIds' | 'activeClue'>): Clue[] {
  const rows = snapshot.board.slice()
  if (snapshot.activeClue && !rows.some((row) => row.clueId === snapshot.activeClue?.id)) {
    rows.push({
      categoryId: snapshot.activeClue.categoryId,
      categoryTitle: 'Final Question',
      categoryPosition: Number.MAX_SAFE_INTEGER,
      clueId: snapshot.activeClue.id,
      boardValue: snapshot.activeClue.boardValue,
      cluePosition: 0,
      clueType: snapshot.activeClue.type,
    })
  }
  return rows
    .slice()
    .sort((a, b) => a.cluePosition - b.cluePosition)
    .map((row): Clue => {
      const used = snapshot.usedClueIds.includes(row.clueId)
      const active = snapshot.activeClue?.id === row.clueId ? snapshot.activeClue : undefined
      const uiType = toUiClueType(row.clueType)
      const base = {
        id: row.clueId,
        categoryId: row.categoryId,
        value: row.boardValue,
        used,
        prompt: active?.prompt ?? '',
        timerSeconds: active?.timerSeconds ?? 30,
        special: active?.special,
        mediaUrl: active?.mediaUrl,
        revealMediaUrl: active?.revealMediaUrl,
        revealGif: active?.revealGif,
        revealedAnswer: formatRevealedAnswer(active),
      }
      if (uiType === 'music-multiple-choice') {
        return { ...base, type: uiType, options: optionsFromChoices(active?.choices) }
      }
      if (uiType === 'price-slider') {
        return {
          ...base,
          type: uiType,
          min: active?.price?.min ?? 0,
          max: active?.price?.max ?? 100,
          step: active?.price?.step ?? 1,
          unitPrefix: active?.price?.prefix ?? '$',
        }
      }
      return { ...base, type: uiType }
    })
}

/** Ranks players by score and applies authoritative deltas for the revealed clue. */
export function leaderboardFromPlayers(
  players: RawPlayerScore[],
  scoreDeltas?: Map<string, number>,
): LeaderboardEntry[] {
  return [...players]
    .sort((a, b) => b.score - a.score)
    .map((player, index) => {
      return {
        playerId: player.playerId,
        nickname: player.nickname,
        teamName: player.teamName,
        score: player.score,
        rank: index + 1,
        delta: scoreDeltas?.get(player.playerId),
      }
    })
}

export function scoreDeltasFromSnapshot(
  snapshot: Pick<RawSnapshot, 'phase' | 'results'>,
): Map<string, number> | undefined {
  return snapshot.phase !== 'FINISHED' && snapshot.results
    ? new Map(snapshot.results.map((result) => [result.playerId, result.pointsAwarded]))
    : undefined
}

export function playersFromSnapshot(snapshot: Pick<RawSnapshot, 'players' | 'submissions'>): Player[] {
  const answered = new Set((snapshot.submissions ?? []).map((submission) => submission.playerId))
  return snapshot.players.map((player) => ({
    id: player.playerId,
    nickname: player.nickname,
    teamName: player.teamName,
    score: player.score,
    connected: player.connected,
    hasAnsweredCurrentClue: snapshot.submissions ? answered.has(player.playerId) : undefined,
  }))
}

export function roomFromSnapshot(snapshot: RawSnapshot): RoomSummary {
  return {
    code: snapshot.code,
    phase: snapshot.phase,
    joinUrl: snapshot.joinUrl,
    locked: snapshot.joiningLocked,
    stateVersion: snapshot.stateVersion,
    deadline: snapshot.deadline,
    finalRound: Boolean(snapshot.finalRound),
    hasFinalQuestion: Boolean(snapshot.hasFinalQuestion),
    teams: snapshot.teams ?? [],
  }
}

export function ownResultFromSnapshot(
  snapshot: Pick<RawSnapshot, 'results'>,
  playerId: string | null,
): GameState['ownResult'] {
  if (!playerId || !snapshot.results) return undefined
  const mine = snapshot.results.find((result) => result.playerId === playerId)
  if (!mine) return undefined
  return { correct: Boolean(mine.correct), pointsAwarded: mine.pointsAwarded }
}

export function priceResultsFromSnapshot(snapshot: RawSnapshot): PriceResultEntry[] | undefined {
  if (snapshot.activeClue?.type !== 'price_slider' || !snapshot.results) return undefined
  const nicknames = new Map(snapshot.players.map((player) => [player.playerId, player.nickname]))
  return snapshot.results
    .map((result) => {
      const answer = JSON.parse(result.answer) as unknown
      return {
        playerId: result.playerId,
        nickname: nicknames.get(result.playerId) ?? 'Player',
        guess: answer === null ? Number.NaN : Number(answer),
        pointsAwarded: result.pointsAwarded,
        rank: result.rank,
        overbid: result.rank === null,
      }
    })
    .filter((result) => Number.isFinite(result.guess))
    .sort(
      (left, right) =>
        right.pointsAwarded - left.pointsAwarded ||
        (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) ||
        left.nickname.localeCompare(right.nickname),
    )
    .slice(0, 3)
}
