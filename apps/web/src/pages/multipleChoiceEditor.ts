import type { ServerClueConfig } from '../lib/apiClient'

export function findCorrectChoice(config: ServerClueConfig): number | null {
  const answer = config.correctAnswer?.trim().toLocaleLowerCase()
  if (!answer) return null
  const index = config.choices?.findIndex((choice) => choice.trim().toLocaleLowerCase() === answer) ?? -1
  return index < 0 ? null : index
}

export function hasCorrectChoice(config: ServerClueConfig, selectedChoiceIndex: number | null): boolean {
  return selectedChoiceIndex !== null && Boolean(config.choices?.[selectedChoiceIndex]?.trim())
}

type ChoiceChange =
  | { kind: 'select'; index: number }
  | { kind: 'rename'; index: number; value: string }
  | { kind: 'remove'; index: number }

export function changeMultipleChoice(
  config: ServerClueConfig,
  selectedChoiceIndex: number | null,
  change: ChoiceChange,
): { config: ServerClueConfig; selectedChoiceIndex: number | null } {
  const choices = [...(config.choices ?? [])]
  if (change.kind === 'select') {
    selectedChoiceIndex = change.index
  } else if (change.kind === 'rename') {
    choices[change.index] = change.value
  } else {
    choices.splice(change.index, 1)
    if (selectedChoiceIndex === change.index) selectedChoiceIndex = null
    else if (selectedChoiceIndex !== null && selectedChoiceIndex > change.index) selectedChoiceIndex -= 1
  }
  return {
    selectedChoiceIndex,
    config: {
      ...config,
      choices,
      correctAnswer: selectedChoiceIndex === null ? '' : choices[selectedChoiceIndex] ?? '',
    },
  }
}
