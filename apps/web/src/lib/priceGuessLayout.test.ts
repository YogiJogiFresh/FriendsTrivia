import { describe, expect, it } from 'vitest'
import { groupPriceGuesses, layoutPriceLabels, priceAxis, pricePosition } from './priceGuessLayout'
import type { PriceResultEntry } from '../data/types'

describe('revealed price line layout', () => {
  it('groups coincident prices while keeping every literal name and amount', () => {
    const guesses = Array.from({ length: 50 }, (_, index) => ({
      playerId: `p${index}`, nickname: `<Player ${index}>`, guess: index % 2 ? 0 : 10,
      rank: 1, pointsAwarded: 100, overbid: false,
    } satisfies PriceResultEntry))
    const groups = groupPriceGuesses(guesses)
    expect(groups.map(group => group.guess)).toEqual([0, 10])
    expect(groups.flatMap(group => group.players)).toHaveLength(50)
    expect(groups[0]?.players[0]?.nickname).toBe('<Player 1>')
    expect(guesses[0]?.guess).toBe(10)
  })
  it('uses proportional positions, including zero/endpoints/decimals and legacy out-of-range guesses', () => {
    const axis = priceAxis(0, 2, 1.2, [0, 1.1, 1.3, 2])!
    expect(pricePosition(0, axis.min, axis.max, 224)).toBe(12)
    expect(pricePosition(2, axis.min, axis.max, 224)).toBe(212)
    expect(pricePosition(1.2, axis.min, axis.max, 224)).toBe(132)
    expect(priceAxis(0, 2, 1.2, [3])).toEqual({ min: 0, max: 3 })
    expect(priceAxis(0, 0, 0, [])).toBeUndefined()
    expect(priceAxis(0, 2, NaN, [])).toBeUndefined()
  })
  it('stacks crowded labels without overlapping and accounts for variable full-name heights', () => {
    const sizes = [{ width: 80, height: 30 }, { width: 90, height: 70 }, { width: 80, height: 30 },
      { width: 100, height: 40 }]
    const layout = layoutPriceLabels([12, 15, 140, 288], sizes, 300)
    expect(layout.labels.map(label => label.lane)).toEqual([0, 0, 0, 1])
    expect(layout.labels[3]?.top).toBe(82)
    expect(layout.height).toBe(134)
    for (const [index, label] of layout.labels.entries()) {
      expect(label.left).toBeGreaterThanOrEqual(0)
      expect(label.left + sizes[index]!.width).toBeLessThanOrEqual(300)
      expect(label.top + sizes[index]!.height).toBeLessThan(layout.height)
    }
    expect(layoutPriceLabels([], [], 300)).toEqual({ labels: [], height: 0 })
  })
})
