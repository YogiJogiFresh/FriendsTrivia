import { useEffect, useState } from 'react'
import { Button } from '../common'
import styles from './TutorialSlideshow.module.css'

const SLIDES = [
  {
    eyebrow: 'Step 1',
    title: 'Join the room',
    description:
      'Scan the QR code or open the room link on your phone. Enter a nickname and choose a team when teams are enabled.',
    callout: 'No app or account required',
  },
  {
    eyebrow: 'Step 2',
    title: 'Watch the shared screen',
    description:
      'The host chooses each clue. Listen to music and follow the prompt here, then answer privately from your phone.',
    callout: 'Your answers stay hidden',
  },
  {
    eyebrow: 'Step 3',
    title: 'Lock in your answer',
    description:
      'Choose an option, type the song, or set a price before time expires. Submit carefully—you get one submission.',
    callout: 'Fast correct music answers score more',
  },
  {
    eyebrow: 'Step 4',
    title: 'Get closest without going over',
    description:
      'For Price Is Right clues, the closest guess at or below the real price wins the most points. Overbids score zero.',
    callout: 'Use the slider and submit',
  },
  {
    eyebrow: 'Step 5',
    title: 'Expect surprises',
    description:
      'Special clues can change the timer or scoring. If there is a Final Question, wager your points before the last clue.',
    callout: 'Highest score wins',
  },
] as const

const AUTO_ADVANCE_MS = 8_000

export function TutorialSlideshow() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [activeIndex, setActiveIndex] = useState(0)
  const [playing, setPlaying] = useState(!reduceMotion)

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % SLIDES.length)
    }, AUTO_ADVANCE_MS)
    return () => window.clearInterval(timer)
  }, [playing])

  function showPrevious() {
    setActiveIndex((current) => (current - 1 + SLIDES.length) % SLIDES.length)
  }

  function showNext() {
    setActiveIndex((current) => (current + 1) % SLIDES.length)
  }

  const slide = SLIDES[activeIndex]!

  return (
    <section className={styles.slideshow} aria-labelledby="tutorial-title">
      <div className={styles.header}>
        <div>
          <span className={styles.label}>How to play</span>
          <h2 id="tutorial-title">Ready for trivia?</h2>
        </div>
        <Button variant="ghost" onClick={() => setPlaying((current) => !current)}>
          {playing ? 'Pause' : 'Play'}
        </Button>
      </div>

      <div className={styles.slide}>
        <span className={styles.eyebrow}>{slide.eyebrow}</span>
        <h3>{slide.title}</h3>
        <p>{slide.description}</p>
        <strong>{slide.callout}</strong>
      </div>

      <div className={styles.controls}>
        <Button variant="secondary" onClick={showPrevious} aria-label="Previous tutorial slide">
          Previous
        </Button>
        <div className={styles.dots} aria-label={`Tutorial slide ${activeIndex + 1} of ${SLIDES.length}`}>
          {SLIDES.map((candidate, index) => (
            <button
              key={candidate.title}
              type="button"
              className={index === activeIndex ? styles.activeDot : styles.dot}
              onClick={() => setActiveIndex(index)}
              aria-label={`Show tutorial slide ${index + 1}: ${candidate.title}`}
              aria-current={index === activeIndex ? 'step' : undefined}
            />
          ))}
        </div>
        <Button variant="secondary" onClick={showNext} aria-label="Next tutorial slide">
          Next
        </Button>
      </div>
    </section>
  )
}
