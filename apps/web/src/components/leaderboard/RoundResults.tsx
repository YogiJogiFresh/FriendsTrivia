import type { CSSProperties } from 'react'
import type { AnswerBreakdown, LeaderboardEntry } from '../../data/types'
import { Leaderboard } from './Leaderboard'
import styles from './RoundResults.module.css'

const choiceColors = [
  '--category-accent-1', '--category-accent-2', '--category-accent-3',
  '--category-accent-4', '--category-accent-5', '--category-accent-6',
  '--color-danger', '--color-success', '--color-text',
]

export function RoundResults({ entries, breakdown, choicePresentation = 'table' }: {
  entries: LeaderboardEntry[]
  breakdown?: AnswerBreakdown
  choicePresentation?: 'table' | 'bars'
}) {
  return (
    <div className={styles.results}>
      {breakdown ? <section className={styles.section} aria-label="Answer breakdown">
        <h2>{breakdown.kind === 'multiple-choice' ? 'Answer choices' : 'Player answers'}</h2>
        {breakdown.total === 0 ? <p>No eligible players for this clue.</p> : breakdown.kind === 'multiple-choice' ? choicePresentation === 'bars' ? (
          <ul className={styles.choiceBars} aria-label="Answer choice percentages and player counts">
            {breakdown.choices.map((choice, index) => <li key={index} className={styles.choiceRow}
              style={{ '--choice-color': index === breakdown.choices.length - 1
                ? 'var(--color-text-muted)' : `var(${choiceColors[index % choiceColors.length]})` } as CSSProperties}>
              <span className={styles.choiceLabel}>{choice.label}</span>
              <div className={styles.choiceTrack}>
                <span className={styles.choiceFill} style={{ width: `${choice.percentage}%` }} />
                <span className={styles.choicePercentage}>{choice.percentage}%</span>
              </div>
              <span className={styles.choiceCount} aria-label={`${choice.count} players`}>{choice.count}</span>
            </li>)}
          </ul>
        ) : <>
          <p>Percentage of all {breakdown.total} eligible players. Rounded to whole percentages.</p>
          <table className={styles.table}>
            <thead><tr><th scope="col">Answer</th><th scope="col">Players</th><th scope="col">Percent</th></tr></thead>
            <tbody>{breakdown.choices.map((choice, index) => <tr key={index}>
              <th scope="row">{choice.label}</th><td>{choice.count}</td><td>{choice.percentage}%</td>
            </tr>)}</tbody>
          </table>
        </> : <table className={[styles.table, styles.textAnswers].join(' ')}>
          <thead><tr><th scope="col">Player</th><th scope="col">Submitted answer</th></tr></thead>
          <tbody>{breakdown.responses.map(response => <tr key={response.playerId}>
            <th scope="row">{response.nickname}</th>
            <td>{response.answer === null ? <em>No answer</em> : response.answer}</td>
          </tr>)}</tbody>
        </table>}
      </section> : null}
      <section className={styles.section} aria-label="Leaderboard">
        <h2>Leaderboard</h2>
        <Leaderboard entries={entries} />
      </section>
    </div>
  )
}
