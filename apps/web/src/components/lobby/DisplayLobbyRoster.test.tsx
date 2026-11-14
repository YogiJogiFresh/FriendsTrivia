import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  refs: [] as unknown[],
  states: [] as unknown[],
  refIndex: 0,
  stateIndex: 0,
  effect: null as null | (() => () => void),
}))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: () => ({ current: harness.refs[harness.refIndex++] }),
  useState: (initial: unknown) => {
    const index = harness.stateIndex++
    harness.states[index] ??= initial
    return [harness.states[index], (next: unknown) => { harness.states[index] = next }]
  },
  useEffect: (effect: () => () => void) => { harness.effect = effect },
}))

import { DisplayLobbyRoster } from './DisplayLobbyRoster'

let clock: number
let frames: Map<number, FrameRequestCallback>
let cleanup: (() => void) | undefined
let resize: () => void
let card: EventTarget & { matches: ReturnType<typeof vi.fn>; contains: ReturnType<typeof vi.fn> }
let viewport: EventTarget & {
  scrollTop: number; scrollHeight: number; clientHeight: number
  matches: ReturnType<typeof vi.fn>; contains: ReturnType<typeof vi.fn>
}
let motion: EventTarget & { matches: boolean }
let visibility: EventTarget & { hidden: boolean }
let disconnect: ReturnType<typeof vi.fn>

function mount(paused = false) {
  harness.states[0] = paused
  DisplayLobbyRoster({ players: [] })
  cleanup = harness.effect!()
}

function advance(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    clock += 16
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(clock)
  }
}

beforeEach(() => {
  clock = 0
  frames = new Map()
  card = Object.assign(new EventTarget(), { matches: vi.fn(() => false), contains: vi.fn(() => false) })
  viewport = Object.assign(new EventTarget(), {
    scrollTop: 0, scrollHeight: 140, clientHeight: 100,
    matches: vi.fn(() => false), contains: vi.fn(() => false),
  })
  motion = Object.assign(new EventTarget(), { matches: false })
  visibility = Object.assign(new EventTarget(), { hidden: false })
  disconnect = vi.fn()
  harness.refs = [card, viewport, {}]
  harness.states = []
  harness.refIndex = harness.stateIndex = 0
  vi.stubGlobal('window', { matchMedia: () => motion })
  vi.stubGlobal('document', visibility)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('scrolls slowly in both directions with a pause at each end', () => {
  let actualScrollTop = 0
  Object.defineProperty(viewport, 'scrollTop', {
    get: () => actualScrollTop,
    set: (value: number) => { actualScrollTop = Math.round(value) },
  })
  mount()
  expect(harness.states[1]).toBe(true)
  advance(1_000)
  expect(viewport.scrollTop).toBe(0)
  advance(2_000)
  expect(viewport.scrollTop).toBeGreaterThan(15)
  expect(viewport.scrollTop).toBeLessThan(20)
  advance(1_500)
  expect(viewport.scrollTop).toBe(40)
  advance(1_000)
  expect(viewport.scrollTop).toBe(40)
  advance(2_000)
  expect(viewport.scrollTop).toBeLessThan(40)
  advance(2_000)
  expect(viewport.scrollTop).toBe(0)
})

it('pauses for interaction, reduced motion and hidden tabs, and stops when the list fits', () => {
  mount()
  for (const event of ['pointerenter', 'focusin']) {
    const target = event === 'pointerenter' ? card : viewport
    target.dispatchEvent(new Event(event))
    expect(frames.size).toBe(0)
    target.dispatchEvent(new Event(event === 'pointerenter' ? 'pointerleave' : 'focusout'))
    expect(frames.size).toBe(1)
  }
  card.matches.mockReturnValue(true)
  resize()
  expect(frames.size).toBe(0)
  card.matches.mockReturnValue(false)
  motion.matches = true
  motion.dispatchEvent(new Event('change'))
  expect(frames.size).toBe(0)
  expect(harness.states[2]).toBe(true)
  motion.matches = false
  motion.dispatchEvent(new Event('change'))
  visibility.hidden = true
  visibility.dispatchEvent(new Event('visibilitychange'))
  expect(frames.size).toBe(0)
  visibility.hidden = false
  visibility.dispatchEvent(new Event('visibilitychange'))
  expect(frames.size).toBe(1)
  viewport.scrollHeight = 100
  resize()
  expect(harness.states[1]).toBe(false)
  expect(frames.size).toBe(0)
})

it('honors manual pause', () => {
  mount(true)
  expect(frames.size).toBe(0)
})

it('removes observers, animation and listeners on unmount', () => {
  mount()
  expect(frames.size).toBe(1)
  cleanup!()
  expect(disconnect).toHaveBeenCalledOnce()
  card.dispatchEvent(new Event('pointerleave'))
  motion.dispatchEvent(new Event('change'))
  visibility.dispatchEvent(new Event('visibilitychange'))
  expect(frames.size).toBe(0)
  cleanup = undefined
})
