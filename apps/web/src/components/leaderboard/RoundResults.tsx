import type { AnswerBreakdown, LeaderboardEntry } from '../../data/types'
import { Leaderboard } from './Leaderboard'
import styles from './RoundResults.module.css'

export function RoundResults({ entries, breakdown }: { entries: LeaderboardEntry[]; breakdown?: AnswerBreakdown }) {
  return (
    <div className={styles.results}>
      {breakdown ? <section className={styles.section} aria-label="Answer breakdown">
        <h2>{breakdown.kind === 'multiple-choice' ? 'Answer choices' : 'Player answers'}</h2>
        {breakdown.total === 0 ? <p>No eligible players for this clue.</p> : breakdown.kind === 'multiple-choice' ? <>
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
