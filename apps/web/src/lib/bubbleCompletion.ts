export interface BubbleProgress {
  scope: string
  connected: boolean
  accepting: boolean
  visible: boolean
  answered: number
  total: number
  roster: string
}

export interface BubbleCompletion {
  progress: BubbleProgress
  consumed: boolean
  celebrate: boolean
}

export function bubbleCompletion(previous: BubbleCompletion | undefined, progress: BubbleProgress): BubbleCompletion {
  const complete = progress.accepting && progress.total > 0 && progress.answered === progress.total
  if (!previous || previous.progress.scope !== progress.scope) {
    return { progress, consumed: complete, celebrate: false }
  }
  if (Object.keys(progress).every(key =>
    progress[key as keyof BubbleProgress] === previous.progress[key as keyof BubbleProgress])) return previous
  const before = previous.progress
  const celebrate = !previous.consumed && complete &&
    progress.connected && before.connected && progress.accepting && before.accepting &&
    progress.visible && before.visible && progress.roster === before.roster &&
    progress.total === before.total && progress.answered > before.answered
  return {
    progress,
    consumed: previous.consumed || complete,
    celebrate: previous.celebrate || celebrate,
  }
}
