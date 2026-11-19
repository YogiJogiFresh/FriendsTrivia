export interface BubbleSize { width: number; height: number }
export interface BubbleBody extends BubbleSize {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  glowUntil: number
}

const inset = 8

export function canFloatBubbles(bounds: BubbleSize, sizes: BubbleSize[]) {
  return sizes.length > 0 && bounds.width > 0 && bounds.height > 0 &&
    sizes.every(size => size.width + inset * 2 < bounds.width * 0.6 &&
      size.height + inset * 2 < bounds.height * 0.4) &&
    sizes.reduce((area, size) => area + (size.width + 16) * (size.height + 16), 0) <
      bounds.width * bounds.height * 0.3
}

export function containBubble(body: BubbleBody, bounds: BubbleSize) {
  for (const [position, velocity, length] of [
    ['x', 'vx', 'width'], ['y', 'vy', 'height'],
  ] as const) {
    const minimum = Math.min(inset, Math.max(0, bounds[length] - body[length]) / 2)
    const maximum = Math.max(minimum, bounds[length] - body[length] - inset)
    if (body[position] < minimum) {
      body[position] = minimum
      body[velocity] = Math.abs(body[velocity])
    } else if (body[position] > maximum) {
      body[position] = maximum
      body[velocity] = -Math.abs(body[velocity])
    }
  }
}

export function createBubbleBody(id: string, index: number, count: number,
  size: BubbleSize, bounds: BubbleSize): BubbleBody {
  let seed = 0
  for (const char of id) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * bounds.width / Math.max(1, bounds.height))))
  const rows = Math.max(1, Math.ceil(count / columns))
  const angle = (seed % 360) * Math.PI / 180
  const speed = 32 + seed % 17
  const body = {
    id, ...size,
    x: (index % columns + 0.5) * bounds.width / columns - size.width / 2,
    y: (Math.floor(index / columns) + 0.5) * bounds.height / rows - size.height / 2,
    vx: (Math.cos(angle) >= 0 ? 1 : -1) * Math.max(0.35, Math.abs(Math.cos(angle))) * speed,
    vy: (Math.sin(angle) >= 0 ? 1 : -1) * Math.max(0.35, Math.abs(Math.sin(angle))) * speed,
    glowUntil: 0,
  }
  containBubble(body, bounds)
  return body
}

export function stepBubbles(bodies: BubbleBody[], bounds: BubbleSize, elapsed: number, now: number) {
  const seconds = Math.min(0.04, Math.max(0, elapsed))
  const hits = new Set<string>()
  for (const body of bodies) {
    body.x += body.vx * seconds
    body.y += body.vy * seconds
    containBubble(body, bounds)
  }
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j]
      const dx = a.x + a.width / 2 - b.x - b.width / 2
      const dy = a.y + a.height / 2 - b.y - b.height / 2
      const overlapX = (a.width + b.width) / 2 - Math.abs(dx)
      const overlapY = (a.height + b.height) / 2 - Math.abs(dy)
      if (overlapX <= 0 || overlapY <= 0) continue
      const horizontal = overlapX < overlapY
      const position = horizontal ? 'x' : 'y'
      const velocity = horizontal ? 'vx' : 'vy'
      const length = horizontal ? 'width' : 'height'
      const direction = (horizontal ? dx : dy) >= 0 ? 1 : -1
      const separation = (horizontal ? overlapX : overlapY) + 0.1
      const aRoom = Math.max(0, direction > 0
        ? bounds[length] - inset - a[length] - a[position] : a[position] - inset)
      const bRoom = Math.max(0, direction > 0
        ? b[position] - inset : bounds[length] - inset - b[length] - b[position])
      const bMove = Math.min(bRoom, separation - Math.min(aRoom, separation / 2))
      a[position] += direction * Math.min(aRoom, separation - bMove)
      b[position] -= direction * bMove
      if ((a[velocity] - b[velocity]) * direction < 0) {
        const previous = a[velocity]
        a[velocity] = b[velocity]
        b[velocity] = previous
        if (now >= a.glowUntil && now >= b.glowUntil) {
          hits.add(a.id); hits.add(b.id)
          a.glowUntil = b.glowUntil = now + 400
        }
      }
      containBubble(a, bounds)
      containBubble(b, bounds)
    }
  }
  return hits
}
