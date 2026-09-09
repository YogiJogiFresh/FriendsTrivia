import { useState } from 'react'
import { useHistory } from '../data/hooks'
import type { ServerHistoryDetail } from '../lib/apiClient'
import {
  clearHistory,
  deleteHistoryGame,
  getHistoryDetail,
  historyExportCsvUrl,
} from '../lib/apiClient'
import { Button, Card, PageContainer, Podium } from '../components'
import type { LeaderboardEntry } from '../data/types'
import styles from './HistoryPage.module.css'

function formatDate(iso: string | null): string {
  if (!iso) return 'In progress'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatDuration(createdAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null
  const minutes = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(createdAt)) / 60000))
  return `${minutes} min`
}

function podiumFromDetail(detail: ServerHistoryDetail): LeaderboardEntry[] {
  return [...detail.players]
    .sort((a, b) => b.score - a.score)
    .map((player, index) => ({
      playerId: player.id,
      nickname: player.nickname,
      teamName: player.teamName,
      score: player.score,
      rank: index + 1,
    }))
}

export function HistoryPage() {
  const { data: games, loading, error, refetch } = useHistory()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ServerHistoryDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)

  async function toggleExpanded(id: string) {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      setDetail(await getHistoryDetail(id))
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Could not load this game.')
    } finally {
      setDetailLoading(false)
    }
  }

  async function handleDeleteGame(id: string, title: string) {
    if (!window.confirm(`Delete the completed game "${title}"? This cannot be undone.`)) return
    setDeletingId(id)
    setDeleteError(null)
    try {
      await deleteHistoryGame(id)
      if (expandedId === id) {
        setExpandedId(null)
        setDetail(null)
      }
      refetch()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete this game.')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleClearHistory() {
    if (!games?.length) return
    if (!window.confirm(`Delete all ${games.length} completed games? This cannot be undone.`)) return
    setClearing(true)
    setDeleteError(null)
    try {
      await clearHistory()
      setExpandedId(null)
      setDetail(null)
      refetch()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not clear game history.')
    } finally {
      setClearing(false)
    }
  }

  return (
    <PageContainer>
      <div className={styles.pageHeader}>
        <div>
          <h1>Game history</h1>
          <p>Browse completed games and export results.</p>
        </div>
        <Button
          variant="danger"
          disabled={!games?.length || clearing}
          onClick={handleClearHistory}
        >
          {clearing ? 'Clearing…' : 'Clear all history'}
        </Button>
      </div>

      {loading ? <p>Loading history…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {deleteError ? <p role="alert">{deleteError}</p> : null}

      <div className={styles.list}>
        {games?.map((game) => {
          const duration = formatDuration(game.createdAt, game.completedAt)
          return (
            <Card key={game.id} className={styles.gameCard}>
              <div className={styles.gameHeader}>
                <span className={styles.gameTitle}>{game.packTitle}</span>
                <span className={styles.gameMeta}>
                  {formatDate(game.completedAt ?? game.createdAt)} · {game.playerCount} players
                  {duration ? ` · ${duration}` : ''} · room {game.code}
                </span>
              </div>

              {expandedId === game.id ? (
                <>
                  {detailLoading ? <p>Loading results…</p> : null}
                  {detailError ? <p role="alert">{detailError}</p> : null}
                  {detail && detail.room.id === game.id ? <Podium entries={podiumFromDetail(detail)} /> : null}
                </>
              ) : null}

              <div className={styles.exportRow}>
                <Button variant="secondary" onClick={() => toggleExpanded(game.id)}>
                  {expandedId === game.id ? 'Hide results' : 'View results'}
                </Button>
                <Button variant="secondary" href={historyExportCsvUrl(game.id)} download>
                  Export CSV
                </Button>
                <Button
                  variant="danger"
                  disabled={deletingId === game.id}
                  onClick={() => handleDeleteGame(game.id, game.packTitle)}
                >
                  {deletingId === game.id ? 'Deleting…' : 'Delete game'}
                </Button>
              </div>
            </Card>
          )
        })}
        {games && games.length === 0 ? <p>No games have been played yet.</p> : null}
      </div>
    </PageContainer>
  )
}
