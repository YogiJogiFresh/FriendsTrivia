import type { ServerClueDetail } from './apiClient'
import { mediaStreamUrl } from './apiClient'
import { cluesFromSnapshot } from './snapshot'
import type { RawActiveClue, RawBoardRow } from './snapshot'

export interface PreviewDraftClue extends Omit<ServerClueDetail, 'id' | 'position'> {
  key: string
  selectedChoiceIndex: number | null
}

export interface PreviewDraftCategory {
  key: string
  title: string
  clues: PreviewDraftClue[]
}

export function boardFromDraft(categories: PreviewDraftCategory[]): RawBoardRow[] {
  return categories.flatMap((category, categoryPosition) =>
    category.clues.flatMap((clue, cluePosition) => clue.finalQuestion ? [] : [{
      categoryId: category.key,
      categoryTitle: category.title || 'Untitled category',
      categoryPosition,
      clueId: clue.key,
      boardValue: clue.boardValue,
      cluePosition,
      clueType: clue.type,
    }]),
  )
}

export function clueFromDraft(categories: PreviewDraftCategory[], clueKey: string, revealed: boolean) {
  const category = categories.find((entry) => entry.clues.some((clue) => clue.key === clueKey))
  const draft = category?.clues.find((clue) => clue.key === clueKey)
  if (!category || !draft) return null

  const config = draft.config
  const answer = draft.type === 'price_slider'
    ? Number.isFinite(config.correctPrice) ? config.correctPrice : undefined
    : draft.type === 'music_multiple_choice'
      ? draft.selectedChoiceIndex === null ? undefined : config.choices?.[draft.selectedChoiceIndex]
      : config.correctAnswer
  const activeClue: RawActiveClue = {
    id: draft.key,
    categoryId: category.key,
    type: draft.type,
    boardValue: draft.boardValue,
    prompt: draft.prompt,
    timerSeconds: draft.timerSeconds,
    mediaUrl: draft.mediaAssetId ? mediaStreamUrl(draft.mediaAssetId) : undefined,
    revealMediaUrl: draft.revealMediaAssetId ? mediaStreamUrl(draft.revealMediaAssetId) : undefined,
    revealGif: revealed ? config.revealGif : undefined,
    choices: config.choices,
    price: {
      min: config.min ?? 0,
      max: config.max ?? 100,
      step: config.step ?? 1,
      prefix: config.prefix ?? '$',
    },
    answer: revealed && (typeof answer === 'number' || answer?.trim()) ? answer : undefined,
  }
  const clue = cluesFromSnapshot({ board: [], usedClueIds: [], activeClue })[0]
  return clue ? { clue, categoryTitle: category.title || 'Untitled category', finalQuestion: draft.finalQuestion } : null
}
