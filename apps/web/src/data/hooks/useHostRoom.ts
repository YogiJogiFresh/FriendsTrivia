import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameState } from '../types'
import { emitWithAck, getSocket, SocketAckError } from '../../lib/socketClient'
import { getHostToken } from '../../lib/roomStorage'
import {
  categoriesFromBoard,
  cluesFromSnapshot,
  expectedRoomContext,
  leaderboardFromPlayers,
  priceResultsFromSnapshot,
  playersFromSnapshot,
  roomFromSnapshot,
  scoreDeltasFromSnapshot,
} from '../../lib/snapshot'
import type { RawSnapshot } from '../../lib/snapshot'
import { useConnectionStatus } from './useConnectionStatus'
import { traceEvent } from '../../lib/diagnostics'
import { commandObserved, type CommandReceipt } from '../../lib/hostCommands'

export interface HostRoomResult {
  game: GameState | null
  loading: boolean
  /** Set when there is no host session for this room in this browser, or the server rejected it. */
  error: string | null
  sendCommand: (command: string, payload?: Record<string, unknown>) => Promise<unknown>
  pendingCommand: string | null
  recoveryRequests: HostRecoveryRequest[]
  decideRecovery: (id: string, approved: boolean) => Promise<unknown>
}
export interface HostRecoveryRequest {
  id: string; playerId: string; nickname: string; teamName: string | null; score: number; expiresAt: string
}
interface PendingCommand {
  cancelled: boolean
  observe?: () => void
  reject?: (error: Error) => void
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
  const [recoveryRequests, setRecoveryRequests] = useState<HostRecoveryRequest[]>([])
  const [pendingCommand, setPendingCommand] = useState<string | null>(null)
  const latest = useRef<RawSnapshot | null>(null)
  const synchronize = useRef<(() => Promise<RawSnapshot>) | null>(null)
  const needsSync = useRef(false)
  const inFlight = useRef<PendingCommand | null>(null)
  const connection = useConnectionStatus()
  const hostToken = getHostToken(roomCode)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSnapshot(null)
    setRecoveryRequests([])
    latest.current = null
    needsSync.current = false
    setPendingCommand(null)

    if (!hostToken) {
      setError('No host session was found for this room in this browser. Create the room again from Host a game.')
      setLoading(false)
      return undefined
    }

    const socket = getSocket()
    let generation = 0
    let connecting = false
    let connectionId = socket.id
    let snapshotSequence = 0

    function connectAsHost() {
      if (cancelled || connecting || !socket.connected) return
      connecting = true
      const attempt = generation
      emitWithAck<RawSnapshot>('host:connect', { code: roomCode, hostToken })
        .then((next) => {
          if (!cancelled && attempt === generation) {
            handleSnapshot(next)
            setError(null)
            setLoading(false)
          }
        })
        .catch((err: Error) => {
          if (!cancelled && attempt === generation) {
            setError(err.message)
            setLoading(false)
          }
        })
        .finally(() => { if (attempt === generation) connecting = false })
    }

    function handleSnapshot(next: RawSnapshot) {
      traceEvent('snapshot:received', { phase: next.phase, roomGeneration: next.roomGeneration,
        stateVersion: next.stateVersion, snapshotSequence: next.snapshotSequence, clueId: next.activeClue?.id })
      if (!cancelled && next.code === roomCode && (next.snapshotSequence ?? 0) >= snapshotSequence) {
        snapshotSequence = next.snapshotSequence ?? 0
        latest.current = next
        needsSync.current = false
        setSnapshot(next)
        inFlight.current?.observe?.()
      }
      synchronize.current = async () => {
        if (cancelled || !socket.connected) throw new Error('Reconnect before sending another action.')
        const next = await emitWithAck<RawSnapshot>('host:connect', { code: roomCode, hostToken })
        if (cancelled) throw new Error('The room changed.')
        handleSnapshot(next)
        return next
      }
    }

    function handleRequests(requests: HostRecoveryRequest[]) {
      if (!cancelled) setRecoveryRequests(requests)
    }
    function disconnected() {
      needsSync.current = true
      inFlight.current?.reject?.(new Error('Connection interrupted. Verify the current state before retrying.'))
      generation++
      connecting = false
      snapshotSequence = 0
      if (!cancelled) setRecoveryRequests([])
    }
    function connected() {
      if (socket.id === connectionId && connecting) return
      connectionId = socket.id
      generation++
      connecting = false
      connectAsHost()
    }
    socket.on('host:snapshot', handleSnapshot)
    socket.on('host:recovery-requests', handleRequests)
    socket.on('connect', connected)
    socket.on('disconnect', disconnected)
    if (socket.connected) connectAsHost()

    return () => {
      cancelled = true
      synchronize.current = null
      if (inFlight.current) {
        inFlight.current.cancelled = true
        inFlight.current.reject?.(new Error('The room changed.'))
        inFlight.current = null
      }
      socket.off('host:snapshot', handleSnapshot)
      socket.off('connect', connected)
      socket.off('host:recovery-requests', handleRequests)
      socket.off('disconnect', disconnected)
    }
  }, [roomCode, hostToken])

  const sendCommand = useCallback(async (command: string, payload: Record<string, unknown> = {}) => {
    if (inFlight.current) throw new Error('Wait for the current action to finish.')
    if (!getSocket().connected) throw new Error('Reconnect before sending another action.')
    const operation: PendingCommand = { cancelled: false }
    inFlight.current = operation
    setPendingCommand(command)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (needsSync.current || !latest.current) await synchronize.current?.()
      if (operation.cancelled || !latest.current) throw new Error('The room changed.')
      const receipt = await emitWithAck<CommandReceipt | undefined>('host:command', {
        command, ...payload, ...expectedRoomContext(latest.current),
      })
      if (operation.cancelled) throw new Error('The room changed.')
      if (command === 'replay' || command === 'end') return receipt
      if (!receipt || !Number.isFinite(receipt.snapshotSequence)) {
        await synchronize.current?.()
        return receipt
      }
      await new Promise<void>((resolve, reject) => {
        operation.reject = reject
        operation.observe = () => {
          const current = latest.current
          if (commandObserved(current, receipt)) resolve()
        }
        operation.observe()
        timer = setTimeout(() => {
          void synchronize.current?.().then(() => {
            const current = latest.current
            if (commandObserved(current, receipt)) resolve()
            else reject(new Error('State could not be confirmed. Refresh before sending another action.'))
          }, reject)
        }, 2000)
      })
      return receipt
    } catch (error) {
      if (!operation.cancelled) {
        needsSync.current = true
        try { await synchronize.current?.() } catch { /* The next action must synchronize first. */ }
      }
      if (error instanceof SocketAckError && error.code === 'timeout') {
        throw new Error('The action may have completed. Check the current phase or score before retrying.')
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (inFlight.current === operation) {
        inFlight.current = null
        setPendingCommand(null)
      }
    }
  }, [])
  const decideRecovery = useCallback((id: string, approved: boolean) =>
    emitWithAck('host:recovery-decision', {
      recoveryId: id, approved, expectedRoomGeneration: snapshot?.roomGeneration,
    }), [snapshot])

  useEffect(() => {
    if (snapshot) traceEvent('snapshot:rendered', {
      phase: snapshot.phase, roomGeneration: snapshot.roomGeneration,
      stateVersion: snapshot.stateVersion, snapshotSequence: snapshot.snapshotSequence, clueId: snapshot.activeClue?.id,
    })
  }, [snapshot])

  if (!snapshot) return { game: null, loading, error, sendCommand, pendingCommand, recoveryRequests, decideRecovery }

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

  return { game, loading, error, sendCommand, pendingCommand, recoveryRequests, decideRecovery }
}
