import type { CSSProperties } from 'react'
import type { LeaderboardEntry } from '../../data/types'
import styles from './Leaderboard.module.css'

export interface LeaderboardProps {
  entries: LeaderboardEntry[]
  highlightPlayerId?: string
}

/** Ranked list view, used mid-game on the shared display and host controls. */
export function Leaderboard({ entries, highlightPlayerId }: LeaderboardProps) {
  const teamMode = entries.some((entry) => entry.teamName)
  if (teamMode) {
    const teams = new Map<string, LeaderboardEntry[]>()
    for (const entry of entries) {
      const teamName = entry.teamName ?? 'Unassigned'
      teams.set(teamName, [...(teams.get(teamName) ?? []), entry])
    }
    const rankedTeams = [...teams.entries()]
      .map(([name, members]) => ({
        name,
        members: members.sort((left, right) => right.score - left.score),
        score: members.reduce((total, member) => total + member.score, 0),
      }))
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))

    return (
      <ol className={styles.list} aria-label="Team leaderboard">
        {rankedTeams.map((team, index) => (
          <li key={team.name} className={styles.teamGroup}>
            <div className={styles.teamHeader}>
              <span className={styles.rank}>{index + 1}</span>
              <span className={styles.teamName}>{team.name}</span>
              <span className={styles.score}>{team.score.toLocaleString()}</span>
            </div>
            <ul className={styles.teamMembers}>
              {team.members.map((entry) => (
                <li
                  key={entry.playerId}
                  className={[
                    styles.memberRow,
                    entry.playerId === highlightPlayerId ? styles.rowHighlight : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className={styles.nickname}>{entry.nickname}</span>
                  {typeof entry.delta === 'number' ? (
                    <span
                      className={[styles.delta, entry.delta === 0 ? styles.deltaZero : '']
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                    </span>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <ol className={styles.list} aria-label="Leaderboard">
      {entries.map((entry) => (
        <li
          key={entry.playerId}
          className={[styles.row, entry.playerId === highlightPlayerId ? styles.rowHighlight : '']
            .filter(Boolean)
            .join(' ')}
        >
          <span className={styles.rank} aria-hidden="true">
            {entry.rank}
          </span>
          <span className={styles.nickname}>{entry.nickname}</span>
          <span className={styles.score}>{entry.score.toLocaleString()}</span>
          {typeof entry.delta === 'number' ? (
            <span className={[styles.delta, entry.delta === 0 ? styles.deltaZero : ''].filter(Boolean).join(' ')}>
              {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
            </span>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ol>
  )
}

const medalColors = ['var(--color-amber)', '#c7d0e6', '#d98a4c']
const placeClassNames = ['first', 'second', 'third'] as const

export interface PodiumProps {
  entries: LeaderboardEntry[]
}

/** Top-3 podium view for the final results / history screens. */
export function Podium({ entries }: PodiumProps) {
  const teamMode = entries.some((entry) => entry.teamName)
  const top3 = teamMode
    ? [...entries.reduce((teams, entry) => {
        const name = entry.teamName ?? 'Unassigned'
        const existing = teams.get(name)
        teams.set(name, {
          playerId: `team-${name}`,
          nickname: name,
          teamName: name,
          score: (existing?.score ?? 0) + entry.score,
          rank: 0,
        })
        return teams
      }, new Map<string, LeaderboardEntry>()).values()]
        .sort((left, right) => right.score - left.score || left.nickname.localeCompare(right.nickname))
        .slice(0, 3)
    : entries.slice(0, 3)

  return (
    <div className={styles.podium}>
      {top3.map((entry, index) => (
        <div
          key={entry.playerId}
          className={[styles.podiumPlace, styles[placeClassNames[index] ?? 'third']].join(' ')}
          style={{ '--place-color': medalColors[index] } as CSSProperties}
        >
          <span className={styles.medal} aria-hidden="true">
            {index + 1}
          </span>
          <span className={styles.podiumNickname}>{entry.nickname}</span>
          <span className={styles.podiumScore}>{entry.score.toLocaleString()} pts</span>
        </div>
      ))}
    </div>
  )
}
