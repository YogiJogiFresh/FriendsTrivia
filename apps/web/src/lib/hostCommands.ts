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
