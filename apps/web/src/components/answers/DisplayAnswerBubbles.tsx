import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Player } from '../../data/types'
import { bubbleCompletion } from '../../lib/bubbleCompletion'
import { canFloatBubbles, containBubble, createBubbleBody, stepBubbles, type BubbleBody, type BubbleSize } from '../../lib/bubbleMotion'
import styles from './DisplayAnswerBubbles.module.css'

export function DisplayAnswerBubbles({ players, connected, progress, scope, paused, accepting, children }: {
  players: Player[]
  connected: boolean
  progress?: { answered: number; total: number }
  scope: string
  paused: boolean
  accepting: boolean
  children: ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const bodies = useRef(new Map<string, BubbleBody>())
  const geometry = useRef<{ bounds: BubbleSize; sizes: Map<string, BubbleSize> }>({
    bounds: { width: 0, height: 0 }, sizes: new Map(),
  })
  const glows = useRef(new Map<string, Animation>())
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden')
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [compact, setCompact] = useState(true)
  const ordered = [...players].sort((a, b) => a.id.localeCompare(b.id))
  const roster = JSON.stringify(ordered.map(player => [player.id, player.nickname]))
  const answered = ordered.filter(player => player.hasAnsweredCurrentClue).length
  const answeredIds = JSON.stringify(ordered.filter(player => player.hasAnsweredCurrentClue).map(player => player.id))
  const total = progress?.total ?? players.length
  const complete = accepting && total > 0 && progress?.answered === total
  const input = {
    scope, connected, accepting, visible, answered: progress?.answered ?? answered,
    total, roster: JSON.stringify(ordered.map(player => player.id)),
  }
  const [completion, setCompletion] = useState(() => bubbleCompletion(undefined, input))
  const next = bubbleCompletion(completion, input)
  if (next !== completion) setCompletion(next)
  const columns = Math.max(1, Math.floor(size.width / 100))
  const rows = Math.max(1, Math.ceil(players.length / columns))
  const frozen = paused || !connected || !visible

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden')
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    const motionChanged = () => setReduced(preference.matches)
    document.addEventListener('visibilitychange', changed)
    preference.addEventListener('change', motionChanged)
    return () => {
      document.removeEventListener('visibilitychange', changed)
      preference.removeEventListener('change', motionChanged)
    }
  }, [])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    })
    observer.observe(frame.current!)
    const fontsChanged = () => setSize({ width: frame.current!.clientWidth, height: frame.current!.clientHeight })
    document.fonts.addEventListener('loadingdone', fontsChanged)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', fontsChanged)
    }
  }, [])

  useLayoutEffect(() => {
    const element = list.current!
    if (!size.width || !size.height) return
    const stage = element.parentElement!
    // Probe natural labels in the full arena, including unanswered seats.
    stage.dataset.compact = 'false'
    element.style.setProperty('--bubble-font', '18px')
    const sizes = new Map<string, BubbleSize>()
    for (const bubble of element.querySelectorAll<HTMLElement>('[data-bubble]')) {
      sizes.set(bubble.dataset.bubble!, { width: bubble.offsetWidth, height: bubble.offsetHeight })
    }
    const bounds = { width: element.clientWidth, height: element.clientHeight }
    const previous = geometry.current.bounds
    for (const body of bodies.current.values()) {
      if (previous.width && previous.height) {
        body.x *= bounds.width / previous.width
        body.y *= bounds.height / previous.height
      }
      Object.assign(body, sizes.get(body.id))
      containBubble(body, bounds)
    }
    geometry.current = { bounds, sizes }
    const useCompact = reduced || !canFloatBubbles(bounds, [...sizes.values()])
    stage.dataset.compact = String(useCompact)
    setCompact(useCompact)
    if (!useCompact) return
    let lower = 0
    let upper = 14
    // Measure hidden seats too, so another submission never resizes the clue.
    for (let pass = 0; pass < 8; pass++) {
      const font = (lower + upper) / 2
      element.style.setProperty('--bubble-font', `${font}px`)
      let fits = true
      for (const bubble of element.querySelectorAll<HTMLElement>('[data-bubble]')) {
        const slot = bubble.parentElement!
        if (bubble.offsetHeight > Math.max(1, slot.clientHeight - 4)) fits = false
      }
      if (fits) lower = font
      else upper = font
    }
    element.style.setProperty('--bubble-font', `${lower}px`)
  }, [size, reduced, roster])

  useLayoutEffect(() => {
    const nodes = new Map<string, HTMLElement>()
    const { bounds, sizes } = geometry.current
    const all = [...list.current!.querySelectorAll<HTMLElement>('[data-bubble]')]
    for (const [index, bubble] of all.entries()) {
      const slot = bubble.parentElement!
      if (slot.dataset.answered !== 'true') continue
      const id = bubble.dataset.bubble!
      nodes.set(id, slot)
      const measured = sizes.get(id)
      if (measured && !bodies.current.has(id)) {
        bodies.current.set(id, createBubbleBody(id, index, all.length, measured, bounds))
      }
    }
    for (const id of bodies.current.keys()) {
      if (!nodes.has(id)) {
        bodies.current.delete(id)
        glows.current.get(id)?.cancel()
        glows.current.delete(id)
      }
    }
    if (compact || reduced) {
      for (const slot of nodes.values()) slot.style.transform = ''
      for (const animation of glows.current.values()) animation.cancel()
      glows.current.clear()
      return
    }
    const active = [...bodies.current.values()]
    const paint = () => {
      for (const body of active) {
        nodes.get(body.id)!.style.transform = `translate(${body.x}px, ${body.y}px)`
      }
    }
    paint()
    for (const animation of glows.current.values()) {
      if (frozen && animation.playState === 'running') animation.pause()
      else if (!frozen && animation.playState === 'paused') animation.play()
    }
    if (frozen || !active.length) return
    let request = 0
    let last: number | undefined
    function tick(now: number) {
      const hits = stepBubbles(active, bounds, last === undefined ? 0 : (now - last) / 1000, now)
      last = now
      paint()
      for (const id of hits) {
        glows.current.get(id)?.cancel()
        const bubble = nodes.get(id)!.firstElementChild!
        glows.current.set(id, bubble.animate([
          { boxShadow: '0 0 12px var(--color-teal)', borderColor: 'var(--color-teal-strong)' },
          { boxShadow: '0 0 0 transparent', borderColor: 'var(--color-teal)' },
        ], { duration: 320, easing: 'ease-out' }))
      }
      request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [compact, reduced, frozen, size, roster, answeredIds])

  useEffect(() => {
    const animations = glows.current
    return () => {
      for (const animation of animations.values()) animation.cancel()
      animations.clear()
    }
  }, [])

  const variables = {
    '--compact-columns': columns,
    '--compact-rows': rows,
    '--roster-height': `${players.length ? Math.min(size.height * 0.6, rows * 52) : 0}px`,
  } as CSSProperties

  return (
    <div ref={frame} className={styles.frame}>
      <div className={styles.stage} data-compact={compact} data-frozen={frozen} style={variables}>
        <div className={styles.question}>{children}</div>
        <ul ref={list} className={styles.roster} aria-label="Players who answered">
          {ordered.map(player => <li key={player.id} className={styles.slot}
            aria-hidden={!player.hasAnsweredCurrentClue} data-answered={Boolean(player.hasAnsweredCurrentClue)}>
            <span className={styles.bubble} data-bubble={player.id}>{player.nickname}</span>
          </li>)}
        </ul>
        <p className={styles.status} role="status" aria-atomic="true">
          {!connected ? 'Answer status unavailable while reconnecting.'
            : complete ? `Everyone's in! ${answered}/${total} players answered`
              : `${answered}${progress ? `/${total}` : ''} players answered`}
        </p>
        {next.celebrate ? <div className={styles.celebration} aria-hidden="true">
          {Array.from({ length: 20 }, (_, index) => <i key={index} style={{
            '--particle-x': `${index % 2 ? 96 : 4}%`,
            '--particle-y': `${8 + Math.floor(index / 2) * 8}%`,
            '--particle-turn': `${index * 47}deg`,
            '--particle-color': `var(--category-accent-${index % 3 + 1})`,
          } as CSSProperties} />)}
        </div> : null}
      </div>
    </div>
  )
}
