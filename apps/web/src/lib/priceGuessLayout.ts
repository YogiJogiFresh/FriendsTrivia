import type { PriceResultEntry } from '../data/types'

export function groupPriceGuesses(guesses: PriceResultEntry[]) {
  const grouped = new Map<number, PriceResultEntry[]>()
  for (const guess of guesses) {
    if (!Number.isFinite(guess.guess)) continue
    const players = grouped.get(guess.guess) ?? []
    players.push(guess)
    grouped.set(guess.guess, players)
  }
  return [...grouped].sort(([left], [right]) => left - right)
    .map(([guess, players]) => ({ guess, players }))
}

export function priceAxis(min: number, max: number, target: number, prices: number[]) {
  if (![min, max, target].every(Number.isFinite) || max <= min) return undefined
  // Legacy out-of-range answers still need honest positions, rather than clamped markers.
  return { min: Math.min(min, target, ...prices), max: Math.max(max, target, ...prices) }
}

export function pricePosition(price: number, min: number, max: number, width: number) {
  return 12 + (price - min) / (max - min) * Math.max(0, width - 24)
}

export function layoutPriceLabels(
  positions: number[], sizes: { width: number; height: number }[], width: number,
) {
  const lanes: { spans: { left: number; right: number }[]; height: number }[] = []
  const labels = positions.map((position, index) => {
    const size = sizes[index]!
    const preferred = Math.max(0, Math.min(width - size.width, position - size.width / 2))
    let left = preferred, lane = 0
    for (; lane < lanes.length; lane++) {
      const spans = lanes[lane]!.spans
      const candidates: number[] = []
      let start = 0
      for (const span of [...spans, { left: width + 8, right: width }]) {
        const end = span.left - 8
        if (end - start >= size.width) candidates.push(Math.max(start, Math.min(end - size.width, preferred)))
        start = span.right + 8
      }
      if (candidates.length) {
        left = candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred))[0]!
        break
      }
    }
    if (lane === lanes.length) lanes.push({ spans: [], height: 0 })
    const row = lanes[lane]!
    row.spans.push({ left, right: left + size.width })
    row.spans.sort((a, b) => a.left - b.left)
    row.height = Math.max(row.height, size.height)
    return { left, lane, center: left + size.width / 2 }
  })
  const tops: number[] = []
  let height = 0
  for (const lane of lanes) {
    tops.push(height)
    height += lane.height + 12
  }
  return { height, labels: labels.map(label => ({ ...label, top: tops[label.lane]! })) }
}
