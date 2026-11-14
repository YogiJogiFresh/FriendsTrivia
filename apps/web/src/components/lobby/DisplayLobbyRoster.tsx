import { useEffect, useRef, useState } from 'react'
import type { Player } from '../../data/types'
import { Button } from '../common'
import { RosterList } from './RosterList'
import styles from './DisplayLobbyRoster.module.css'

export function DisplayLobbyRoster({ players }: { players: Player[] }) {
  const cardRef = useRef<HTMLElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const card = cardRef.current!
    const viewport = viewportRef.current!
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let previousTime = 0
    let direction = 1
    let position = viewport.scrollTop
    let holdUntil = 0

    function stop() {
      cancelAnimationFrame(frame)
      frame = 0
      previousTime = 0
    }

    function tick(time: number) {
      const elapsed = previousTime ? Math.min(time - previousTime, 64) : 0
      previousTime = time
      const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      if (time >= holdUntil) {
        // Accumulate fractional pixels even where scrollTop rounds to whole pixels.
        position = Math.max(0, Math.min(maximum, position + direction * elapsed * 0.018))
        viewport.scrollTop = position
        if (position === 0 || position === maximum) {
          direction *= -1
          holdUntil = time + 2_000
        }
      }
      frame = requestAnimationFrame(tick)
    }

    function start() {
      stop()
      const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 1
      setOverflowing(hasOverflow)
      setReducedMotion(motion.matches)
      if (!hasOverflow || paused || motion.matches || document.hidden ||
        card.matches(':hover') || viewport.matches(':focus-within')) return
      position = viewport.scrollTop
      holdUntil = performance.now() + 2_000
      frame = requestAnimationFrame(tick)
    }

    function onBlur(event: FocusEvent) {
      if (!viewport.contains(event.relatedTarget as Node | null)) start()
    }

    const observer = new ResizeObserver(start)
    observer.observe(viewport)
    observer.observe(contentRef.current!)
    card.addEventListener('pointerenter', stop)
    card.addEventListener('pointerleave', start)
    viewport.addEventListener('focusin', stop)
    viewport.addEventListener('focusout', onBlur)
    motion.addEventListener('change', start)
    document.addEventListener('visibilitychange', start)
    start()
    return () => {
      stop()
      observer.disconnect()
      card.removeEventListener('pointerenter', stop)
      card.removeEventListener('pointerleave', start)
      viewport.removeEventListener('focusin', stop)
      viewport.removeEventListener('focusout', onBlur)
      motion.removeEventListener('change', start)
      document.removeEventListener('visibilitychange', start)
    }
  }, [paused])

  return (
    <section className={styles.card} ref={cardRef} aria-labelledby="lobby-players-title">
      <div className={styles.header}>
        <h2 id="lobby-players-title">Players ({players.length})</h2>
        {overflowing && !reducedMotion ? (
          <Button variant="ghost" onClick={() => setPaused(!paused)}>
            {paused ? 'Resume scrolling' : 'Pause scrolling'}
          </Button>
        ) : null}
      </div>
      <div className={styles.viewport} ref={viewportRef} tabIndex={0} role="region" aria-label="Player list">
        <div ref={contentRef}>
          <RosterList players={players} />
        </div>
      </div>
    </section>
  )
}
