import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Player } from '../../data/types'
import { bubbleCompletion } from '../../lib/bubbleCompletion'
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
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden')
  const ordered = [...players].sort((a, b) => a.id.localeCompare(b.id))
  const roster = JSON.stringify(ordered.map(player => [player.id, player.nickname]))
  const answered = ordered.filter(player => player.hasAnsweredCurrentClue).length
  const total = progress?.total ?? players.length
  const complete = accepting && total > 0 && progress?.answered === total
  const input = {
    scope, connected, accepting, visible, answered: progress?.answered ?? answered,
    total, roster: JSON.stringify(ordered.map(player => player.id)),
  }
  const [completion, setCompletion] = useState(() => bubbleCompletion(undefined, input))
  const next = bubbleCompletion(completion, input)
  if (next !== completion) setCompletion(next)
  const compact = size.width < 1000 || size.height < 440 || players.length === 0 || players.length > 12
  const columns = Math.max(1, Math.floor(size.width / 100))
  const rows = Math.max(1, Math.ceil(players.length / columns))

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    })
    observer.observe(frame.current!)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const element = list.current!
    if (!size.width || !size.height) return
    let lower = 0
    let upper = compact ? 14 : 18
    // Measure hidden seats too, so another submission never resizes the clue.
    for (let pass = 0; pass < 8; pass++) {
      const font = (lower + upper) / 2
      element.style.setProperty('--bubble-font', `${font}px`)
      let fits = true
      for (const bubble of element.querySelectorAll<HTMLElement>('[data-bubble]')) {
        const slot = bubble.parentElement!
        if (bubble.offsetHeight > Math.max(1, slot.clientHeight - (compact ? 4 : 16))) fits = false
      }
      if (fits) lower = font
      else upper = font
    }
    element.style.setProperty('--bubble-font', `${lower}px`)
  }, [size, compact, roster])

  const variables = {
    '--edge-rows': Math.max(1, Math.ceil(players.length / 2)),
    '--compact-columns': columns,
    '--compact-rows': rows,
    '--roster-height': `${players.length ? Math.min(size.height * 0.6, rows * 52) : 0}px`,
  } as CSSProperties

  return (
    <div ref={frame} className={styles.frame}>
      <div className={styles.stage} data-compact={compact} data-frozen={paused || !connected || !visible} style={variables}>
        <div className={styles.question}>{children}</div>
        <ul ref={list} className={styles.roster} aria-label="Players who answered">
          {ordered.map((player, index) => <li key={player.id} className={styles.slot}
            aria-hidden={!player.hasAnsweredCurrentClue} data-answered={Boolean(player.hasAnsweredCurrentClue)}
            style={{ '--edge-column': index % 2 ? 3 : 1, '--edge-row': Math.floor(index / 2) + 1,
              '--drift-duration': `${6 + index % 5}s`, '--drift-delay': `${-index * 1.3}s` } as CSSProperties}>
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
