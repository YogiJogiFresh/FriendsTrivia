import type { RawSnapshot } from './snapshot'

export function playerSnapshot(current: RawSnapshot | null, next: RawSnapshot): RawSnapshot {
  if (!current) return next
  if (current.code !== next.code || current.roomGeneration !== next.roomGeneration ||
    next.stateVersion < current.stateVersion ||
    (next.stateVersion === current.stateVersion && (next.snapshotSequence ?? 0) < (current.snapshotSequence ?? 0))) return current
  return next
}

export function answerScope(snapshot: RawSnapshot | null): string | null {
  return snapshot?.activeClue
    ? JSON.stringify([snapshot.roomGeneration, snapshot.activeClue.id, snapshot.attempt ?? 0])
    : null
}

export function hasAnswer(snapshot: RawSnapshot | null, receipt: RawSnapshot['ownSubmission']): boolean {
  return Boolean(snapshot?.activeClue && receipt && receipt.roomGeneration === snapshot.roomGeneration &&
    receipt.clueId === snapshot.activeClue.id && receipt.attempt === (snapshot.attempt ?? 0))
}
