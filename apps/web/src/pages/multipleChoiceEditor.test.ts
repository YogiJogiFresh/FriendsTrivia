import { describe, expect, it } from 'vitest'
import { changeMultipleChoice, findCorrectChoice, hasCorrectChoice } from './multipleChoiceEditor'

describe('multiple-choice editor selection', () => {
  it('matches existing answers like the server without defaulting missing or unmatched answers', () => {
    expect(findCorrectChoice({ choices: ['Prince', 'Madonna'], correctAnswer: ' MADONNA ' })).toBe(1)
    expect(findCorrectChoice({ choices: ['Prince', 'Madonna'], correctAnswer: 'Other' })).toBeNull()
    expect(findCorrectChoice({ choices: ['', ''], correctAnswer: '' })).toBeNull()
    expect(findCorrectChoice({ choices: ['Prince', 'Madonna'] })).toBeNull()
  })

  it('keeps selection explicit and synchronizes the saved answer when its row is renamed', () => {
    const config = { choices: ['Prince', 'Madonna'], correctAnswer: '', revealGif: undefined }
    const renamed = changeMultipleChoice(config, null, { kind: 'rename', index: 0, value: 'Cher' })
    expect(renamed.selectedChoiceIndex).toBeNull()
    expect(renamed.config.correctAnswer).toBe('')
    const selected = changeMultipleChoice(renamed.config, null, { kind: 'select', index: 1 })
    const edited = changeMultipleChoice(selected.config, selected.selectedChoiceIndex, { kind: 'rename', index: 1, value: 'A-ha' })
    expect(edited).toEqual({ selectedChoiceIndex: 1, config: { ...config, choices: ['Cher', 'A-ha'], correctAnswer: 'A-ha' } })
    expect(config.choices).toEqual(['Prince', 'Madonna'])
    expect(hasCorrectChoice(edited.config, edited.selectedChoiceIndex)).toBe(true)
  })

  it('preserves the selected row through temporary duplicate and blank labels', () => {
    const config = { choices: ['Prince', 'Madonna'], correctAnswer: 'Madonna' }
    const duplicate = changeMultipleChoice(config, 1, { kind: 'rename', index: 0, value: 'Madonna' })
    expect(duplicate.selectedChoiceIndex).toBe(1)
    const blank = changeMultipleChoice(duplicate.config, 1, { kind: 'rename', index: 1, value: ' ' })
    expect(blank.selectedChoiceIndex).toBe(1)
    expect(hasCorrectChoice(blank.config, blank.selectedChoiceIndex)).toBe(false)
    const restored = changeMultipleChoice(blank.config, 1, { kind: 'rename', index: 1, value: 'Cher' })
    expect(restored.config.correctAnswer).toBe('Cher')
    expect(hasCorrectChoice(restored.config, restored.selectedChoiceIndex)).toBe(true)
  })

  it('adjusts selection when preceding rows are removed and clears it when the selected row is removed', () => {
    const config = { choices: ['Prince', 'Madonna', 'Cher', 'A-ha'], correctAnswer: 'Cher' }
    const before = changeMultipleChoice(config, 2, { kind: 'remove', index: 0 })
    expect(before.selectedChoiceIndex).toBe(1)
    expect(before.config.correctAnswer).toBe('Cher')
    const after = changeMultipleChoice(before.config, 1, { kind: 'remove', index: 2 })
    expect(after.selectedChoiceIndex).toBe(1)
    expect(after.config.correctAnswer).toBe('Cher')
    const removed = changeMultipleChoice(after.config, 1, { kind: 'remove', index: 1 })
    expect(removed.selectedChoiceIndex).toBeNull()
    expect(removed.config.correctAnswer).toBe('')
    expect(hasCorrectChoice(removed.config, removed.selectedChoiceIndex)).toBe(false)
  })
})
