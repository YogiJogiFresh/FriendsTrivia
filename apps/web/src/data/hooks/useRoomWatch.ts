import { useEffect, useState } from 'react'
import type { GameState } from '../types'
import { emitWithAck, getSocket } from '../../lib/socketClient'
import {
  categoriesFromBoard,
  cluesFromSnapshot,
  leaderboardFromPlayers,
  priceResultsFromSnapshot,
  playersFromSnapshot,
  roomFromSnapshot,
  scoreDeltasFromSnapshot,
} from '../../lib/snapshot'
import type { RawSnapshot } from '../../lib/snapshot'
import { useConnectionStatus } from './useConnectionStatus'

export interface RoomWatchResult {
  game: GameState | null
  loading: boolean
  error: string | null
}

/**
 * Read-only public view of a room, used by the shared display. Joins the
 * `room:watch` broadcast group and applies every `room:snapshot` push; the
 * socket connection is shared app-wide, so this re-subscribes automatically
 * after a reconnect (Socket.IO drops room membership on disconnect).
 */
export function useRoomWatch(roomCode: string): RoomWatchResult {
  const [snapshot, setSnapshot] = useState<RawSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const connection = useConnectionStatus()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSnapshot(null)

    const socket = getSocket()

    function watch() {
      emitWithAck<RawSnapshot>('room:watch', { code: roomCode })
        .then((next) => {
          if (!cancelled) {
            setSnapshot(next)
            setLoading(false)
          }
        })
        .catch((err: Error) => {
          if (!cancelled) {
            setError(err.message)
            setLoading(false)
          }
        })
    }

    function handleSnapshot(next: RawSnapshot) {
      if (!cancelled && next.code === roomCode) setSnapshot(next)
    }

    watch()
    socket.on('room:snapshot', handleSnapshot)
    socket.on('connect', watch)

    return () => {
      cancelled = true
      socket.off('room:snapshot', handleSnapshot)
      socket.off('connect', watch)
    }
  }, [roomCode])

  if (!snapshot) return { game: null, loading, error }

  const game: GameState = {
    room: roomFromSnapshot(snapshot),
    categories: categoriesFromBoard(snapshot.board),
    clues: cluesFromSnapshot(snapshot),
    players: playersFromSnapshot(snapshot),
    leaderboard: leaderboardFromPlayers(snapshot.players, scoreDeltasFromSnapshot(snapshot)),
    currentClueId: snapshot.activeClue?.id ?? null,
    wageredPlayerIds: snapshot.wageredPlayerIds ?? [],
    priceResults: priceResultsFromSnapshot(snapshot),
    connection,
  }

  return { game, loading, error }
}
