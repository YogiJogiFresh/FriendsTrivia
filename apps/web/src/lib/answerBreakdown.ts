import type { AnswerBreakdown } from '../data/types'
import type { RawSnapshot } from './snapshot'

export function answerBreakdownFromSnapshot(snapshot: RawSnapshot): AnswerBreakdown | undefined {
  const clue = snapshot.activeClue
  if (snapshot.phase !== 'LEADERBOARD' || !clue || clue.type === 'price_slider' || !snapshot.results) return undefined
  const players = clue.special === 'forced_player'
    ? snapshot.players.filter(player => player.playerId === snapshot.forcedPlayerId)
    : snapshot.players
  const answers = new Map<string, string>()
  for (const result of snapshot.results) {
    if (answers.has(result.playerId)) continue
    try {
      const answer: unknown = JSON.parse(result.answer)
      const evaluation = result.evaluation ? JSON.parse(result.evaluation) as { answered?: boolean } | null : null
      if (typeof answer === 'string' && evaluation?.answered !== false) answers.set(result.playerId, answer)
    } catch { /* Invalid legacy results have no usable submitted answer. */ }
  }
  const total = players.length
  if (clue.type === 'music_free_text') return {
    kind: 'free-text', total,
    responses: players.map(player => ({
      playerId: player.playerId, nickname: player.nickname, answer: answers.get(player.playerId) ?? null,
    })),
  }
  const counts = new Map([...new Set(clue.choices ?? [])].map(label => [label, 0]))
  let missing = 0, other = 0
  for (const player of players) {
    const answer = answers.get(player.playerId)
    if (answer === undefined) missing++
    else if (counts.has(answer)) counts.set(answer, counts.get(answer)! + 1)
    else other++
  }
  const rows = [...counts].map(([label, count]) => ({ label, count }))
  if (other) rows.push({ label: 'Other answer', count: other })
  rows.push({ label: 'No answer', count: missing })
  return {
    kind: 'multiple-choice', total,
    choices: rows.map(row => ({ ...row, percentage: total ? Math.round(row.count / total * 100) : 0 })),
  }
}
