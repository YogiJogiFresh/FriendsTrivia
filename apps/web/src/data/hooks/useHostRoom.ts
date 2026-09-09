import { useCallback, useEffect, useState } from 'react'
import type { GameState } from '../types'
import { emitWithAck, getSocket } from '../../lib/socketClient'
import { getHostToken } from '../../lib/roomStorage'
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

export interface HostRoomResult {
  game: GameState | null
  loading: boolean
  /** Set when there is no host session for this room in this browser, or the server rejected it. */
  error: string | null
  sendCommand: (command: string, payload?: Record<string, unknown>) => Promise<unknown>
}

/**
 * Authenticated host view of a room. Reads the `hostToken` saved in this
 * browser when the room was created (see `lib/roomStorage.ts`) and uses it
 * to join the host-only Socket.IO channel, which receives `host:snapshot`
 * (a superset of the public snapshot with per-player submission state).
 */
export function useHostRoom(roomCode: string): HostRoomResult {
  const [snapshot, setSnapshot] = useState<RawSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const connection = useConnectionStatus()
  const hostToken = getHostToken(roomCode)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSnapshot(null)

    if (!hostToken) {
      setError('No host session was found for this room in this browser. Create the room again from Host a game.')
      setLoading(false)
      return undefined
    }

    const socket = getSocket()

    function connectAsHost() {
      emitWithAck<RawSnapshot>('host:connect', { code: roomCode, hostToken })
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

    connectAsHost()
    socket.on('host:snapshot', handleSnapshot)
    socket.on('connect', connectAsHost)

    return () => {
      cancelled = true
      socket.off('host:snapshot', handleSnapshot)
      socket.off('connect', connectAsHost)
    }
  }, [roomCode, hostToken])

  const sendCommand = useCallback(
    (command: string, payload: Record<string, unknown> = {}) =>
      emitWithAck('host:command', {
        command,
        expectedStateVersion: snapshot?.stateVersion,
        ...payload,
      }),
    [snapshot?.stateVersion],
  )

  if (!snapshot) return { game: null, loading, error, sendCommand }

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

  return { game, loading, error, sendCommand }
}
