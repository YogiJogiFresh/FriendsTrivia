import { expect, it } from 'vitest'
import { bubbleCompletion, type BubbleProgress } from './bubbleCompletion'

const start: BubbleProgress = {
  scope: 'room:generation:clue:1', connected: true, accepting: true, visible: true,
  answered: 0, total: 2, roster: 'a,b',
}

it('celebrates live completion once, preserving identity for duplicate progress', () => {
  const first = bubbleCompletion(undefined, start)
  const one = bubbleCompletion(first, { ...start, answered: 1 })
  expect(one.celebrate).toBe(false)
  const complete = bubbleCompletion(one, { ...start, answered: 2 })
  expect(complete.celebrate).toBe(true)
  expect(bubbleCompletion(complete, { ...start, answered: 2 })).toBe(complete)
  const paused = bubbleCompletion(complete, { ...start, answered: 2, accepting: false })
  expect(bubbleCompletion(paused, { ...start, answered: 2 }).celebrate).toBe(true)
  const reset = bubbleCompletion(complete, { ...start, scope: 'room:generation:clue:2' })
  expect(reset.celebrate).toBe(false)
  expect(bubbleCompletion(reset, { ...start, scope: 'room:generation:clue:2', answered: 2 }).celebrate).toBe(true)
})

it('does not celebrate complete bootstrap, reconnect, resume or background return', () => {
  expect(bubbleCompletion(undefined, { ...start, answered: 2 }).celebrate).toBe(false)
  for (const change of [{ connected: false }, { accepting: false }, { visible: false }]) {
    const interrupted = bubbleCompletion(bubbleCompletion(undefined, start), { ...start, ...change })
    expect(bubbleCompletion(interrupted, { ...start, answered: 2 }).celebrate).toBe(false)
  }
  const hiddenComplete = bubbleCompletion(bubbleCompletion(undefined, start),
    { ...start, visible: false, answered: 2 })
  expect(bubbleCompletion(hiddenComplete, { ...start, answered: 2 }).celebrate).toBe(false)
})

it('does not celebrate roster changes, zero eligibility or stale decreasing counts', () => {
  const first = bubbleCompletion(undefined, start)
  expect(bubbleCompletion(first, { ...start, roster: 'a', total: 1, answered: 1 }).celebrate).toBe(false)
  expect(bubbleCompletion(first, { ...start, total: 0 }).celebrate).toBe(false)
  const complete = bubbleCompletion(undefined, { ...start, answered: 2 })
  const lower = bubbleCompletion(complete, { ...start, answered: 1 })
  expect(bubbleCompletion(lower, { ...start, answered: 2 }).celebrate).toBe(false)
})
