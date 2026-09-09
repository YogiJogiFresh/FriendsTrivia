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

export type SpecialType =
  | 'double_points'
  | 'double_or_nothing'
  | 'speed_round'
  | 'forced_player'

export interface GameSettings {
  timerSeconds: number
  speedBonusMax: number
  priceRankPercentages: number[]
  uniqueNicknames: boolean
  teams?: string[]
  specials?: SpecialType[]
}

export interface RoomState {
  phase: GamePhase
  previousPhase?: GamePhase | undefined
  activeClueId?: string | undefined
  usedClueIds: string[]
  deadline?: string | undefined
  startedAt?: string | undefined
  remainingMs?: number | undefined
  revealedAt?: string | undefined
  finalRound?: boolean | undefined
  specialAssignments?: Record<string, SpecialType> | undefined
  specialVotes?: Record<string, string> | undefined
  forcedPlayerId?: string | undefined
}

export interface RoomRecord {
  id: string
  code: string
  packId: string
  hostTokenHash: string
  status: 'lobby' | 'active' | 'paused' | 'finished' | 'abandoned'
  settings: GameSettings
  state: RoomState
  stateVersion: number
  joiningLocked: boolean
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface PlayerRecord {
  id: string
  roomId: string
  nickname: string
  teamName: string | null
  reconnectTokenHash: string
  connected: boolean
  kicked: boolean
  joinedAt: string
  lastSeenAt: string
}

export interface PlayerScore {
  playerId: string
  nickname: string
  teamName: string | null
  score: number
  connected: boolean
}
