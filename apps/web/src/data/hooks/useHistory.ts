import { useCallback, useEffect, useState } from 'react'
import type { ServerHistorySummary } from '../../lib/apiClient'
import { listHistory } from '../../lib/apiClient'

export interface HistoryResult {
  data: ServerHistorySummary[] | null
  loading: boolean
  error: string | null
  refetch: () => void
}

/** Loads completed/abandoned game summaries from `GET /api/history`. */
export function useHistory(): HistoryResult {
  const [data, setData] = useState<ServerHistorySummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listHistory()
      .then((games) => {
        if (!cancelled) setData(games)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const refetch = useCallback(() => setRefreshKey((current) => current + 1), [])

  return { data, loading, error, refetch }
}
