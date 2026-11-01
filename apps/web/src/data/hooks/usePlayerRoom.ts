import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameState } from '../types'
import { emitWithAck, getSocket, newRequestId, SocketAckError } from '../../lib/socketClient'
import { clearPlayerIdentity, getPlayerIdentity, savePlayerIdentity } from '../../lib/roomStorage'
import {
  categoriesFromBoard,
  cluesFromSnapshot,
  expectedRoomContext,
  leaderboardFromPlayers,
  ownResultFromSnapshot,
  playersFromSnapshot,
  roomFromSnapshot,
  scoreDeltasFromSnapshot,
} from '../../lib/snapshot'
import type { RawSnapshot } from '../../lib/snapshot'
import { useConnectionStatus } from './useConnectionStatus'

export interface PlayerRoomResult {
  game: GameState | null
  /** True while attempting the silent reconnect from a stored identity. */
  loading: boolean
  /** Set when there is no player identity to reconnect and a nickname must be collected. */
  needsNickname: boolean
  /** Set when the server rejects the room entirely (bad code, room finished, kicked, etc.). */
  fatalError: string | null
  nickname: string | null
  playerId: string | null
  join: (nickname: string, teamName?: string) => Promise<void>
  joining: boolean
  joinError: string | null
  reconnecting: boolean
  reconnectError: string | null
  retryReconnect: () => void
  recovery: SeatRecovery | null
  requestRecovery: (nickname: string) => Promise<void>
  answerSubmitted: boolean
  submitAnswer: (answer: string | number) => Promise<void>
  submitWager: (amount: number) => Promise<void>
  submitSpecialVote: (playerId: string) => Promise<void>
  submitting: boolean
  submitError: string | null
}

export interface SeatRecovery {
  id: string
  nickname: string
  status: string
  expiresAt?: string
}
interface RecoveredIdentity {
  id: string
  playerId: string
  reconnectToken: string
  nickname: string
  snapshot: RawSnapshot
}

/**
 * Player-side connection to a room: joins (or silently reconnects into)
 * the room, keeps the public snapshot in sync, and submits answers. The
 * `{playerId, reconnectToken}` pair handed out by `player:join` is persisted
 * in `localStorage` (see `lib/roomStorage.ts`) so refreshing the phone page
 * or a dropped connection can resume the same seat via `player:reconnect`.
 */
export function usePlayerRoom(roomCode: string): PlayerRoomResult {
  const [snapshot, setSnapshot] = useState<RawSnapshot | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [nickname, setNickname] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsNickname, setNeedsNickname] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectError, setReconnectError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<SeatRecovery | null>(null)
  const recoveryRef = useRef<SeatRecovery | null>(null)
  const recoveryApprovedRef = useRef<(identity: RecoveredIdentity) => void>(() => {})
  const [answerReceipt, setAnswerReceipt] = useState<RawSnapshot['ownSubmission']>()
  const activePlayerIdRef = useRef<string | null>(null)
  const retryRef = useRef<() => void>(() => {})
  const connection = useConnectionStatus()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFatalError(null)
    setNeedsNickname(false)
    setSnapshot(null)
    setPlayerId(null)
    setNickname(null)
    activePlayerIdRef.current = null
    recoveryRef.current = null
    setRecovery(null)
    setAnswerReceipt(undefined)
    setReconnectError(null)
    setReconnecting(true)

    const socket = getSocket()
    let inFlight = false
    let generation = 0
    let failures = 0
    let connectionId = socket.id
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let terminal = false

    function applySnapshot(next: RawSnapshot) {
      if (!cancelled) {
        setSnapshot(next)
        if (next.ownSubmission) setAnswerReceipt(next.ownSubmission)
      }
    }

    function connectRoom() {
      if (cancelled || terminal || inFlight || !socket.connected) return
      clearTimeout(retryTimer)
      inFlight = true
      const attempt = generation
      const identity = getPlayerIdentity(roomCode)
      setReconnecting(true)
      const request = identity
        ? emitWithAck<RawSnapshot>('player:reconnect', {
            code: roomCode, playerId: identity.playerId, reconnectToken: identity.reconnectToken,
          })
        : emitWithAck<RawSnapshot>('room:watch', { code: roomCode })
      void request
        .then((next) => {
          if (cancelled || attempt !== generation) return
          activePlayerIdRef.current = identity?.playerId ?? null
          setPlayerId(identity?.playerId ?? null)
          setNickname(identity?.nickname ?? null)
          if (identity) setAnswerReceipt(next.ownSubmission)
          applySnapshot(next)
          setNeedsNickname(!identity)
          setLoading(false)
          setReconnecting(false)
          setReconnectError(null)
          failures = 0
        })
        .catch((error: unknown) => {
          if (cancelled || attempt !== generation) return
          setLoading(false)
          const code = error instanceof SocketAckError ? error.code : undefined
          if (code === 'invalid_identity') {
            clearPlayerIdentity(roomCode)
            activePlayerIdRef.current = null
            setPlayerId(null)
            setNickname(null)
            setAnswerReceipt(undefined)
            setNeedsNickname(true)
            setReconnecting(false)
            retryTimer = setTimeout(connectRoom, 0)
          } else if (code === 'player_kicked' || code === 'room_ended' || code === 'not_found') {
            clearPlayerIdentity(roomCode)
            terminal = true
            activePlayerIdRef.current = null
            setFatalError(error instanceof Error ? error.message : 'This seat is no longer available.')
            setReconnecting(false)
          } else {
            setReconnectError(error instanceof Error ? error.message : 'Unable to reconnect. Retrying...')
            retryTimer = setTimeout(connectRoom, Math.min(500 * 2 ** Math.min(failures++, 4), 5_000))
          }
        })
        .finally(() => {
          if (attempt === generation) inFlight = false
        })
    }

    function disconnected() {
      generation++
      inFlight = false
      clearTimeout(retryTimer)
      activePlayerIdRef.current = null
      setReconnecting(true)
      if (recoveryRef.current) {
        recoveryRef.current = { ...recoveryRef.current, status: 'disconnected' }
        setRecovery(recoveryRef.current)
      }
    }

    function handleSnapshot(next: RawSnapshot) {
      if (!cancelled && next.code === roomCode) applySnapshot(next)
    }
    function handleKicked(payload: { playerId?: string }) {
      if (!cancelled && payload.playerId === activePlayerIdRef.current) {
        clearPlayerIdentity(roomCode)
        terminal = true
        generation++
        clearTimeout(retryTimer)
        activePlayerIdRef.current = null
        setReconnecting(false)
        setFatalError('You were removed from this room by the host.')
      }
    }
    function handleReconnectSocket() {
      if (socket.id === connectionId && (inFlight || activePlayerIdRef.current)) return
      connectionId = socket.id
      generation++
      inFlight = false
      connectRoom()
    }
    function handleRecoveryState(next: SeatRecovery) {
      if (cancelled || next.id !== recoveryRef.current?.id) return
      recoveryRef.current = next
      setRecovery(next)
    }
    function handleRecoveryApproved(next: RecoveredIdentity) {
      if (cancelled || next.id !== recoveryRef.current?.id || next.snapshot.code !== roomCode) return
      clearTimeout(retryTimer)
      generation++
      inFlight = false
      savePlayerIdentity(roomCode, {
        playerId: next.playerId, reconnectToken: next.reconnectToken, nickname: next.nickname,
      })
      setAnswerReceipt(next.snapshot.ownSubmission)
      activePlayerIdRef.current = next.playerId
      setPlayerId(next.playerId)
      setNickname(next.nickname)
      applySnapshot(next.snapshot)
      setNeedsNickname(false)
      setLoading(false)
      setReconnecting(false)
      setReconnectError(null)
      recoveryRef.current = null
      setRecovery(null)
    }

    socket.on('room:snapshot', handleSnapshot)
    socket.on('player:kicked', handleKicked)
    socket.on('connect', handleReconnectSocket)
    socket.on('disconnect', disconnected)
    socket.on('player:recovery-state', handleRecoveryState)
    socket.on('player:recovery-approved', handleRecoveryApproved)
    recoveryApprovedRef.current = handleRecoveryApproved
    retryRef.current = connectRoom
    if (socket.connected) connectRoom()

    return () => {
      cancelled = true
      if (recoveryRef.current)
        socket.emit('player:recovery-cancel', { recoveryId: recoveryRef.current.id })
      recoveryRef.current = null
      clearTimeout(retryTimer)
      retryRef.current = () => {}
      recoveryApprovedRef.current = () => {}
      socket.off('room:snapshot', handleSnapshot)
      socket.off('player:kicked', handleKicked)
      socket.off('connect', handleReconnectSocket)
      socket.off('disconnect', disconnected)
      socket.off('player:recovery-state', handleRecoveryState)
      socket.off('player:recovery-approved', handleRecoveryApproved)
    }
  }, [roomCode])

  const requestRecovery = useCallback(async (nicknameInput: string) => {
    const next: SeatRecovery = { id: newRequestId(), nickname: nicknameInput.trim(), status: 'requesting' }
    recoveryRef.current = next
    setRecovery(next)
    setJoinError(null)
    try {
      const request = await emitWithAck<SeatRecovery>('player:recover-request', {
        code: roomCode, nickname: next.nickname, requestId: next.id, expectedRoomGeneration: snapshot?.roomGeneration,
      })
      if (recoveryRef.current?.id !== next.id) return
      recoveryRef.current = request
      setRecovery(request)
      const status = await emitWithAck<SeatRecovery & { identity?: Omit<RecoveredIdentity, 'id'> }>(
        'player:recovery-status', { recoveryId: request.id },
      )
      if (recoveryRef.current?.id !== request.id) return
      if (status.identity) recoveryApprovedRef.current({ ...status.identity, id: request.id })
      else {
        recoveryRef.current = status
        setRecovery(status)
      }
    } catch (error) {
      if (recoveryRef.current?.id !== next.id) return
      recoveryRef.current = { ...next, status: 'failed' }
      setRecovery(recoveryRef.current)
      setJoinError(error instanceof Error ? error.message : 'Could not request seat recovery.')
    }
  }, [roomCode, snapshot])

  const join = useCallback(
    async (nicknameInput: string, teamName?: string) => {
      setJoining(true)
      setJoinError(null)
      try {
        const result = await emitWithAck<{ playerId: string; reconnectToken: string; snapshot: RawSnapshot }>(
          'player:join',
          { code: roomCode, nickname: nicknameInput, teamName },
        )
        savePlayerIdentity(roomCode, {
          playerId: result.playerId,
          reconnectToken: result.reconnectToken,
          nickname: nicknameInput,
        })
        setPlayerId(result.playerId)
        activePlayerIdRef.current = result.playerId
        setNickname(nicknameInput)
        setSnapshot(result.snapshot)
        setNeedsNickname(false)
        setAnswerReceipt(undefined)
        setReconnecting(false)
        setLoading(false)
      } catch (error) {
        setJoinError(error instanceof Error ? error.message : 'Unable to join this room')
      } finally {
        setJoining(false)
      }
    },
    [roomCode],
  )

  const submitAnswer = useCallback(
    async (answer: string | number) => {
      if (!activePlayerIdRef.current) throw new Error('Wait until your seat reconnects.')
      setSubmitting(true)
      setSubmitError(null)
      try {
        await emitWithAck('player:answer', { answer, ...expectedRoomContext(snapshot) })
        if (snapshot?.activeClue && snapshot.roomGeneration !== undefined)
          setAnswerReceipt({ clueId: snapshot.activeClue.id, attempt: snapshot.attempt ?? 0,
            window: snapshot.window ?? 0, roomGeneration: snapshot.roomGeneration })
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Unable to submit your answer')
        throw error
      } finally {
        setSubmitting(false)
      }
    },
    [snapshot],
  )

  const submitWager = useCallback(
    async (amount: number) => {
      if (!activePlayerIdRef.current) throw new Error('Wait until your seat reconnects.')
      setSubmitting(true)
      setSubmitError(null)
      try {
        await emitWithAck('player:wager', { amount, ...expectedRoomContext(snapshot) })
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Unable to submit your wager')
        throw error
      } finally {
        setSubmitting(false)
      }
    },
    [snapshot],
  )

  const submitSpecialVote = useCallback(
    async (targetPlayerId: string) => {
      if (!activePlayerIdRef.current) throw new Error('Wait until your seat reconnects.')
      setSubmitting(true)
      setSubmitError(null)
      try {
        await emitWithAck('player:special-vote', {
          playerId: targetPlayerId,
          ...expectedRoomContext(snapshot),
        })
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Unable to submit your vote')
        throw error
      } finally {
        setSubmitting(false)
      }
    },
    [snapshot],
  )

  const game: GameState | null = snapshot
    ? {
        room: roomFromSnapshot(snapshot),
        categories: categoriesFromBoard(snapshot.board),
        clues: cluesFromSnapshot(snapshot),
        players: playersFromSnapshot(snapshot),
        leaderboard: leaderboardFromPlayers(snapshot.players, scoreDeltasFromSnapshot(snapshot)),
        currentClueId: snapshot.activeClue?.id ?? null,
        wageredPlayerIds: snapshot.wageredPlayerIds ?? [],
        ownResult: ownResultFromSnapshot(snapshot, playerId),
        connection: reconnecting && connection === 'connected' ? 'reconnecting' : connection,
      }
    : null

  return {
    game,
    loading,
    needsNickname,
    fatalError,
    nickname,
    playerId,
    join,
    joining,
    joinError,
    reconnecting,
    reconnectError,
    retryReconnect: () => retryRef.current(),
    recovery,
    requestRecovery,
    answerSubmitted: Boolean(answerReceipt && snapshot && answerReceipt.clueId === snapshot.activeClue?.id &&
      answerReceipt.attempt === snapshot.attempt && answerReceipt.window === snapshot.window &&
      answerReceipt.roomGeneration === snapshot.roomGeneration),
    submitAnswer,
    submitWager,
    submitSpecialVote,
    submitting,
    submitError,
  }
}
