import { useCallback, useEffect, useState } from 'react'
import type { ServerPackSummary } from '../../lib/apiClient'
import { listPacks } from '../../lib/apiClient'

export interface PacksResult {
  data: ServerPackSummary[] | null
  loading: boolean
  error: string | null
  refetch: () => void
}

/** Loads the host's trivia packs from `GET /api/packs`. */
export function usePacks(includeArchived = false): PacksResult {
  const [data, setData] = useState<ServerPackSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listPacks(includeArchived)
      .then((packs) => {
        if (!cancelled) setData(packs)
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
  }, [includeArchived, reloadToken])

  const refetch = useCallback(() => setReloadToken((token) => token + 1), [])

  return { data, loading, error, refetch }
}
