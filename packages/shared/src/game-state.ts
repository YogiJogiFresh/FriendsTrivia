import type { GamePhase } from './contracts.js'

const DIRECT_TRANSITIONS: Readonly<Record<Exclude<GamePhase, 'PAUSED'>, readonly GamePhase[]>> = {
  LOBBY: ['BOARD', 'FINISHED'],
  BOARD: ['CLUE_READY', 'FINAL_WAGER', 'FINISHED', 'PAUSED'],
  CLUE_READY: ['SPECIAL_VOTE', 'ACCEPTING_ANSWERS', 'BOARD', 'PAUSED'],
  SPECIAL_VOTE: ['ACCEPTING_ANSWERS', 'BOARD', 'PAUSED'],
  ACCEPTING_ANSWERS: ['ANSWERS_CLOSED', 'BOARD', 'PAUSED'],
  ANSWERS_CLOSED: ['REVEAL', 'BOARD', 'FINISHED', 'PAUSED'],
  REVEAL: ['LEADERBOARD', 'BOARD', 'PAUSED'],
  LEADERBOARD: ['BOARD', 'FINAL_WAGER', 'FINISHED', 'PAUSED'],
  FINAL_WAGER: ['FINAL_QUESTION', 'PAUSED'],
  FINAL_QUESTION: ['ANSWERS_CLOSED', 'FINISHED', 'PAUSED'],
  FINISHED: [],
}

export function isGamePhaseTransitionAllowed(
  from: GamePhase,
  to: GamePhase,
  pausedFromPhase?: Exclude<GamePhase, 'PAUSED'>,
): boolean {
  if (from === 'PAUSED') {
    return pausedFromPhase !== undefined && to === pausedFromPhase
  }
  return DIRECT_TRANSITIONS[from].includes(to)
}

export function assertGamePhaseTransition(
  from: GamePhase,
  to: GamePhase,
  pausedFromPhase?: Exclude<GamePhase, 'PAUSED'>,
): void {
  if (!isGamePhaseTransitionAllowed(from, to, pausedFromPhase)) {
    throw new Error(`Invalid game phase transition: ${from} -> ${to}`)
  }
}
