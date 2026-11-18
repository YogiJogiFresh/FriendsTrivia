import type { GameState } from '../data/types'

export function nextHostAction(game: Pick<GameState, 'room' | 'categories' | 'clues' | 'currentClueId'>) {
  const { room, categories, clues, currentClueId } = game
  if (room.phase === 'REVEAL') return 'leaderboard'
  if (room.phase !== 'BOARD' && room.phase !== 'LEADERBOARD') return undefined
  if (room.finalRound) return room.phase === 'LEADERBOARD' ? 'finish' : undefined
  const remaining = categories.some(category => category.clueIds.some(id =>
    id !== currentClueId && clues.some(clue => clue.id === id && !clue.used)))
  if (!remaining && room.hasFinalQuestion) return 'startFinal'
  return room.phase === 'LEADERBOARD' ? remaining ? 'board' : 'finish' : undefined
}

export interface CommandReceipt {
  roomGeneration: string
  stateVersion: number
  snapshotSequence: number
}

export function commandObserved(snapshot: { roomGeneration?: string; stateVersion: number; snapshotSequence?: number } | null,
  receipt: CommandReceipt): boolean {
  return Boolean(snapshot && snapshot.roomGeneration === receipt.roomGeneration &&
    snapshot.stateVersion >= receipt.stateVersion && (snapshot.snapshotSequence ?? 0) > receipt.snapshotSequence)
}

export const commandLabels: Record<string, string> = {
  start: 'Starting game', selectClue: 'Starting clue', startFinal: 'Opening final wagers',
  startFinalQuestion: 'Starting Final Question', openAnswers: 'Opening answers',
  resolveSpecialVote: 'Starting selected question', closeAnswers: 'Closing answers', reveal: 'Revealing answer',
  leaderboard: 'Showing leaderboard', board: 'Returning to board', goBack: 'Returning clue to board',
  resetClue: 'Resetting clue', skip: 'Skipping clue', replay: 'Replaying audio', pause: 'Pausing game',
  resume: 'Resuming game', finish: 'Finishing game', end: 'Ending session', lock: 'Updating room lock',
  kick: 'Removing player', adjustScore: 'Updating score',
}
