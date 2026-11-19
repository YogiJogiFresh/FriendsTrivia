import { expect, it } from 'vitest'
import { canFloatBubbles, createBubbleBody, stepBubbles, type BubbleBody } from './bubbleMotion'

const bounds = { width: 800, height: 400 }
const body = (id: string, x: number, vx: number): BubbleBody =>
  ({ id, x, y: 100, vx, vy: 0, width: 80, height: 40, glowUntil: 0 })

it('allows roomy large rosters, but rejects crowded or oversized labels', () => {
  expect(canFloatBubbles({ width: 1920, height: 900 },
    Array.from({ length: 50 }, () => ({ width: 120, height: 40 })))).toBe(true)
  expect(canFloatBubbles({ width: 400, height: 240 },
    Array.from({ length: 20 }, () => ({ width: 120, height: 40 })))).toBe(false)
  expect(canFloatBubbles(bounds, [{ width: 600, height: 40 }])).toBe(false)
  expect(canFloatBubbles(bounds, [])).toBe(false)
  expect(canFloatBubbles({ width: 0, height: 0 }, [{ width: 80, height: 40 }])).toBe(false)
})

it('seeds stable, bounded positions with movement on both axes', () => {
  const size = { width: 120, height: 40 }
  const a = createBubbleBody('Alex', 3, 20, size, bounds)
  expect(a).toEqual(createBubbleBody('Alex', 3, 20, size, bounds))
  expect(a.x).toBeGreaterThanOrEqual(8)
  expect(a.x + a.width).toBeLessThanOrEqual(bounds.width - 8)
  expect(a.vx).not.toBe(0)
  expect(a.vy).not.toBe(0)
})

it('bounces at walls without a collision glow and bounds long-frame travel', () => {
  const a = body('a', 9, -80)
  expect(stepBubbles([a], bounds, 20, 20_000).size).toBe(0)
  expect(a.x).toBe(8)
  expect(a.vx).toBe(80)
  a.x = 100
  stepBubbles([a], bounds, 20, 40_000)
  expect(a.x).toBeCloseTo(103.2)
})

it('separates colliding unequal labels, exchanges direction and glows once', () => {
  const a = body('a', 100, 40), b = { ...body('b', 178, -40), width: 120 }
  expect([...stepBubbles([a, b], bounds, 0.02, 1000)]).toEqual(['a', 'b'])
  expect(a.x + a.width).toBeLessThan(b.x)
  expect(a.vx).toBe(-40)
  expect(b.vx).toBe(40)
  expect(stepBubbles([a, b], bounds, 0.02, 1020).size).toBe(0)
  a.x = 100; b.x = 178; a.vx = 40; b.vx = -40
  expect(stepBubbles([a, b], bounds, 0.02, 1100).size).toBe(0)
})

it('resolves vertical contact and keeps repeated contacts finite without speeding up', () => {
  const a = { ...body('a', 100, 0), vy: 40 }
  const b = { ...body('b', 100, 0), y: 138, vy: -40 }
  expect(stepBubbles([a, b], bounds, 0.02, 1000).size).toBe(2)
  expect(a.y + a.height).toBeLessThan(b.y)
  for (let i = 0; i < 1000; i++) stepBubbles([a, b], bounds, 0.02, 1020 + i * 20)
  for (const item of [a, b]) {
    expect(Number.isFinite(item.y)).toBe(true)
    expect(Math.abs(item.vy)).toBe(40)
    expect(item.y).toBeGreaterThanOrEqual(8)
    expect(item.y + item.height).toBeLessThanOrEqual(bounds.height - 8)
  }
})

it('separates a contact beside a wall without leaving the pinned labels overlapping', () => {
  const a = body('a', 8, 40), b = body('b', 86, -40)
  stepBubbles([a, b], bounds, 0.02, 1000)
  expect(a.x).toBeGreaterThanOrEqual(8)
  expect(a.x + a.width).toBeLessThan(b.x)
})
