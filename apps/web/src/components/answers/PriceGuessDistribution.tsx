import { useLayoutEffect, useRef, useState } from 'react'
import type { PriceSliderClue, PriceResultEntry } from '../../data/types'
import { groupPriceGuesses, layoutPriceLabels, priceAxis, pricePosition } from '../../lib/priceGuessLayout'
import styles from './PriceGuessDistribution.module.css'

export function PriceGuessDistribution({ clue, guesses }: { clue: PriceSliderClue; guesses: PriceResultEntry[] }) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState({ width: 0, axisY: 28, labelTop: 108,
    sizes: [] as { width: number; height: number }[] })
  const groups = groupPriceGuesses(guesses)
  const signature = JSON.stringify([clue.min, clue.max, clue.revealedPrice, clue.unitPrefix,
    clue.allowOverbid, groups.map(group => [group.guess, group.players.map(player => [player.playerId, player.nickname])])])
  const axis = priceAxis(clue.min, clue.max, clue.revealedPrice!, groups.map(group => group.guess))
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const measure = () => {
      const width = frame.clientWidth
      const sizes = [...frame.querySelectorAll<HTMLElement>('[data-price-label]')]
        .map(label => ({ width: label.offsetWidth, height: label.offsetHeight }))
      const endpointHeights = [...frame.querySelectorAll<HTMLElement>('[data-price-header="endpoint"]')]
        .map(label => label.offsetHeight)
      const axisY = Math.max(28, ...endpointHeights.map(height => height + 12))
      const targetHeight = frame.querySelector<HTMLElement>('[data-price-header="target"]')?.offsetHeight ?? 0
      const labelTop = Math.max(108, axisY + 18 + targetHeight + 20)
      setGeometry(previous => previous.width === width && previous.axisY === axisY &&
        previous.labelTop === labelTop && JSON.stringify(previous.sizes) === JSON.stringify(sizes)
        ? previous : { width, sizes, axisY, labelTop })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    frame.querySelectorAll('[data-price-label], [data-price-header]').forEach(label => observer.observe(label))
    document.fonts?.addEventListener('loadingdone', measure)
    measure()
    return () => {
      observer.disconnect()
      document.fonts?.removeEventListener('loadingdone', measure)
    }
  }, [signature])
  const price = (value: number) => `${clue.unitPrefix ?? '$'}${value.toLocaleString()}`
  if (!axis) return <section className={styles.distribution} aria-label="Price guesses">
    <h2>Price guesses</h2>
    <p>Price scale unavailable.</p>
    {groups.map(group => <p key={group.guess}>{group.players.map(player => player.nickname).join(', ')}: {price(group.guess)}</p>)}
  </section>
  const positions = groups.map(group => pricePosition(group.guess, axis.min, axis.max, geometry.width))
  const layout = layoutPriceLabels(positions, groups.map((_, index) =>
    geometry.sizes[index] ?? { width: 0, height: 0 }), geometry.width)
  const target = pricePosition(clue.revealedPrice!, axis.min, axis.max, geometry.width)
  return <section className={styles.distribution} aria-label="Price guesses">
    <h2>Price guesses</h2>
    <div ref={frameRef} className={styles.chart} style={{ height: geometry.labelTop + layout.height }}>
      <svg className={styles.lines} width="100%" height="100%" aria-hidden="true">
        <line x1="12" x2={Math.max(12, geometry.width - 12)} y1={geometry.axisY} y2={geometry.axisY} className={styles.axis} />
        {groups.map((group, index) => <g key={group.guess}>
          <line x1={positions[index]} y1={geometry.axisY} x2={layout.labels[index]?.center}
            y2={geometry.labelTop + (layout.labels[index]?.top ?? 0)} className={styles.connector} />
          <circle cx={positions[index]} cy={geometry.axisY} r="5" className={styles.guessMarker} />
        </g>)}
        <line x1={target} x2={target} y1={geometry.axisY - 10} y2={geometry.axisY + 14} className={styles.targetMarker} />
      </svg>
      <span data-price-header="endpoint" className={styles.minimum}>{price(axis.min)}</span>
      <span data-price-header="endpoint" className={styles.maximum}>{price(axis.max)}</span>
      <span data-price-header="target" className={styles.targetLabel} style={{
        top: geometry.axisY + 18,
        left: Math.max(0, Math.min(geometry.width - Math.min(224, geometry.width), target - 112)),
      }}>Correct price {price(clue.revealedPrice!)}</span>
      {groups.map((group, index) => <div data-price-label key={group.guess} className={styles.label}
        style={{ left: layout.labels[index]?.left ?? 0, top: geometry.labelTop + (layout.labels[index]?.top ?? 0),
          ...(group.players.length > 1 ? {
            width: `min(100%, ${Math.ceil(Math.sqrt(group.players.length)) * 14}rem)`, maxWidth: '100%',
          } : {}) }}>
        <strong>{price(group.guess)}{clue.allowOverbid === false && group.guess > clue.revealedPrice! ? ' (over)' : ''}</strong>
        <span>{group.players.map(player => player.nickname).join(', ')}</span>
      </div>)}
    </div>
    {!groups.length ? <p className={styles.empty}>No guesses submitted.</p> : null}
  </section>
}
