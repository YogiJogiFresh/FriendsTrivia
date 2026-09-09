/**
 * UI-facing domain types for gameplay screens (Display / Host room / Play).
 *
 * These are intentionally decoupled from the server's exact wire shapes
 * (see `lib/apiClient.ts` for those, and `lib/snapshot.ts` for the
 * conversion between the two): components only ever see the types below,
 * so a future change to the server's snapshot shape only requires updating
 * `lib/snapshot.ts`, not any component.
 */

export type ClueType = 'music-multiple-choice' | 'music-free-text' | 'price-slider'
export type SpecialType =
  | 'double_points'
  | 'double_or_nothing'
  | 'speed_round'
  | 'forced_player'

export const SPECIAL_DETAILS: Record<SpecialType, { name: string; description: string }> = {
  double_points: {
    name: 'Double Points',
    description: 'Every positive award is doubled.',
  },
  double_or_nothing: {
    name: 'Double or Nothing',
    description: 'Win double, or lose the clue value for an incorrect or missing answer.',
  },
  speed_round: {
    name: 'Speed Round',
    description: 'The answer timer is cut in half.',
  },
  forced_player: {
    name: 'Forced Player',
    description: 'Vote for one player to answer. If they miss, everyone else scores.',
  },
}

export interface ClueOption {
  id: string
  label: string
}

export interface RevealGif {
  provider: 'giphy' | 'tenor' | 'url'
  url: string
  previewUrl: string
  alt: string
  sourceUrl: string
}

interface BaseClue {
  id: string
  categoryId: string
  /** Jeopardy-style board value, e.g. 100 / 200 / 300. */
  value: number
  used: boolean
  prompt: string
  timerSeconds: number
  special?: SpecialType
  /** Present on the active clue when it has an attached song. */
  mediaUrl?: string
  /** Optional second clip played once when the answer is revealed. */
  revealMediaUrl?: string
  /** Optional hosted GIF shown only after the answer is revealed. */
  revealGif?: RevealGif
  /**
   * Human-readable correct answer, populated only once the server reveals
   * this clue (phase REVEAL/LEADERBOARD/FINISHED) — absent otherwise, since
   * the answer is a secret until then.
   */
  revealedAnswer?: string
}

export interface MusicMultipleChoiceClue extends BaseClue {
  type: 'music-multiple-choice'
  options: ClueOption[]
}

export interface MusicFreeTextClue extends BaseClue {
  type: 'music-free-text'
}

export interface PriceSliderClue extends BaseClue {
  type: 'price-slider'
  min: number
  max: number
  step: number
  unitPrefix?: string
}

export type Clue = MusicMultipleChoiceClue | MusicFreeTextClue | PriceSliderClue

export interface Category {
  id: string
  title: string
  /** One of the rotating `--category-accent-*` design tokens. */
  accentToken: string
  clueIds: string[]
}

export interface Player {
  id: string
  nickname: string
  teamName: string | null
  score: number
  connected: boolean
  isHost?: boolean
  hasAnsweredCurrentClue?: boolean
}

export interface LeaderboardEntry {
  playerId: string
  nickname: string
  teamName: string | null
  score: number
  rank: number
  /** Points awarded for the currently revealed clue. */
  delta?: number
}

export interface PriceResultEntry {
  playerId: string
  nickname: string
  guess: number
  pointsAwarded: number
  rank: number | null
  overbid: boolean
}

/** Matches `apps/server/src/game/types.ts`'s `GamePhase` exactly. */
export type GamePhase =
  | 'LOBBY'
  | 'BOARD'
  | 'CLUE_READY'
  | 'SPECIAL_VOTE'
  | 'ACCEPTING_ANSWERS'
  | 'ANSWERS_CLOSED'
  | 'REVEAL'
  | 'LEADERBOARD'
  | 'FINAL_WAGER'
  | 'FINAL_QUESTION'
  | 'FINISHED'
  | 'PAUSED'

export type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'offline'

export interface RoomSummary {
  code: string
  phase: GamePhase
  joinUrl: string
  locked: boolean
  stateVersion: number
  deadline?: string
  finalRound: boolean
  hasFinalQuestion: boolean
  teams: string[]
  specialVotedPlayerIds: string[]
  forcedPlayerId?: string
}

export interface GameState {
  room: RoomSummary
  categories: Category[]
  clues: Clue[]
  players: Player[]
  leaderboard: LeaderboardEntry[]
  currentClueId: string | null
  wageredPlayerIds: string[]
  /** Best revealed guesses for a price clue, ordered by awarded points. */
  priceResults?: PriceResultEntry[]
  /** The current player's own result for the just-revealed clue, if any. */
  ownResult?: {
    correct: boolean
    pointsAwarded: number
    awardedBecauseForcedPlayerMissed?: boolean
  }
  connection: ConnectionState
}
