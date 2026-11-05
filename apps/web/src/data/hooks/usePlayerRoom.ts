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
import { answerScope, hasAnswer, playerSnapshot } from '../../lib/playerState'
import { traceEvent } from '../../lib/diagnostics'

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
  answerScopeKey: string | null
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
  const latest = useRef<RawSnapshot | null>(null)
  const receipt = useRef<RawSnapshot['ownSubmission']>(undefined)
  const pendingAnswer = useRef(false)
  const uncertainScope = useRef<string | null>(null)
  const lifecycle = useRef(0)
  const applySnapshotRef = useRef<(next: RawSnapshot) => void>(() => {})
  const synchronizeRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    let cancelled = false
    const effectLifecycle = ++lifecycle.current
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
    latest.current = null
    receipt.current = undefined
    pendingAnswer.current = false
    uncertainScope.current = null
    setSubmitting(false)
    setReconnectError(null)
    setReconnecting(true)

    const socket = getSocket()
    let inFlight = false
    let reconnectRequest: Promise<void> | undefined
    let generation = 0
    let failures = 0
    let connectionId = socket.id
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let terminal = false

    function applySnapshot(next: RawSnapshot) {
      if (!cancelled && next.code === roomCode) {
        const accepted = playerSnapshot(latest.current, next)
        traceEvent(accepted === next ? 'player:snapshot' : 'player:stale-snapshot', {
          roomGeneration: next.roomGeneration, stateVersion: next.stateVersion, snapshotSequence: next.snapshotSequence,
          phase: next.phase,
        })
        latest.current = accepted
        setSnapshot(accepted)
        if (next.ownSubmission && hasAnswer(accepted, next.ownSubmission)) {
          receipt.current = next.ownSubmission
          setAnswerReceipt(next.ownSubmission)
        }
      }
    }
    applySnapshotRef.current = applySnapshot

    function connectRoom() {
      if (cancelled || terminal || !socket.connected) return
      if (inFlight) return reconnectRequest
      clearTimeout(retryTimer)
      inFlight = true
      const attempt = generation
      const identity = getPlayerIdentity(roomCode)
      activePlayerIdRef.current = null
      setReconnecting(true)
      const request = identity
        ? emitWithAck<RawSnapshot>('player:reconnect', {
            code: roomCode, playerId: identity.playerId, reconnectToken: identity.reconnectToken,
          })
        : emitWithAck<RawSnapshot>('room:watch', { code: roomCode })
      reconnectRequest = request
        .then((next) => {
          if (cancelled || attempt !== generation) return
          activePlayerIdRef.current = identity?.playerId ?? null
          setPlayerId(identity?.playerId ?? null)
          setNickname(identity?.nickname ?? null)
          applySnapshot(next)
          uncertainScope.current = null
          setSubmitting(pendingAnswer.current)
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
            receipt.current = undefined
            latest.current = null
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
          if (attempt === generation) {
            inFlight = false
            reconnectRequest = undefined
          }
        })
      return reconnectRequest
    }

    function disconnected() {
      generation++
      inFlight = false
      clearTimeout(retryTimer)
      activePlayerIdRef.current = null
      latest.current = null
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
      latest.current = null
      receipt.current = next.snapshot.ownSubmission
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
    synchronizeRef.current = async () => { await connectRoom() }
    let checking = false
    let lastCheck = -Infinity
    async function checkHealth() {
      const current = latest.current
      if (cancelled || terminal || checking || inFlight || pendingAnswer.current || uncertainScope.current ||
        document.visibilityState === 'hidden' || !socket.connected || !activePlayerIdRef.current || !current ||
        performance.now() - lastCheck < 1_000) return
      checking = true
      lastCheck = performance.now()
      const attempt = generation
      try {
        const result = await emitWithAck<{ inSync: boolean }>('player:sync', {
          roomGeneration: current.roomGeneration, stateVersion: current.stateVersion,
          snapshotSequence: current.snapshotSequence,
        })
        if (!cancelled && attempt === generation && !pendingAnswer.current && !result.inSync) await connectRoom()
      } catch {
        if (!cancelled && attempt === generation && !pendingAnswer.current && socket.connected) {
          socket.disconnect()
          socket.connect()
        }
      } finally { checking = false }
    }
    const healthTimer = setInterval(() => { void checkHealth() }, 15_000)
    const checkVisible = () => { void checkHealth() }
    document.addEventListener('visibilitychange', checkVisible)
    window.addEventListener('focus', checkVisible)
    window.addEventListener('online', checkVisible)
    if (socket.connected) connectRoom()

    return () => {
      cancelled = true
      lifecycle.current = effectLifecycle + 1
      if (recoveryRef.current)
        socket.emit('player:recovery-cancel', { recoveryId: recoveryRef.current.id })
      recoveryRef.current = null
      clearTimeout(retryTimer)
      clearInterval(healthTimer)
      document.removeEventListener('visibilitychange', checkVisible)
      window.removeEventListener('focus', checkVisible)
      window.removeEventListener('online', checkVisible)
      synchronizeRef.current = async () => {}
      applySnapshotRef.current = () => {}
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
      const attempt = lifecycle.current
      const request = await emitWithAck<SeatRecovery>('player:recover-request', {
        code: roomCode, nickname: next.nickname, requestId: next.id, expectedRoomGeneration: snapshot?.roomGeneration,
      })
      if (attempt !== lifecycle.current || recoveryRef.current?.id !== next.id) return
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
      const attempt = lifecycle.current
      setJoining(true)
      setJoinError(null)
      try {
        const result = await emitWithAck<{ playerId: string; reconnectToken: string; snapshot: RawSnapshot }>(
          'player:join',
          { code: roomCode, nickname: nicknameInput, teamName },
        )
        if (attempt !== lifecycle.current) return
        savePlayerIdentity(roomCode, {
          playerId: result.playerId,
          reconnectToken: result.reconnectToken,
          nickname: nicknameInput,
        })
        setPlayerId(result.playerId)
        activePlayerIdRef.current = result.playerId
        setNickname(nicknameInput)
        applySnapshotRef.current(result.snapshot)
        setNeedsNickname(false)
        setAnswerReceipt(undefined)
        setReconnecting(false)
        setLoading(false)
      } catch (error) {
        if (attempt === lifecycle.current) setJoinError(error instanceof Error ? error.message : 'Unable to join this room')
      } finally {
        if (attempt === lifecycle.current) setJoining(false)
      }
    },
    [roomCode],
  )

  const submitAnswer = useCallback(
    async (answer: string | number) => {
      if (!activePlayerIdRef.current) throw new Error('Wait until your seat reconnects.')
      if (pendingAnswer.current || uncertainScope.current || hasAnswer(latest.current, receipt.current))
        throw new Error('Your answer is already pending or submitted.')
      const scope = answerScope(snapshot)
      if (!scope || scope !== answerScope(latest.current) || snapshot?.window !== latest.current?.window)
        throw new Error('The question changed. Check the current question before submitting.')
      const attempt = lifecycle.current
      pendingAnswer.current = true
      setSubmitting(true)
      setSubmitError(null)
      try {
        await emitWithAck('player:answer', { answer, ...expectedRoomContext(snapshot) })
        if (attempt === lifecycle.current && snapshot?.activeClue && snapshot.roomGeneration !== undefined) {
          const accepted = { clueId: snapshot.activeClue.id, attempt: snapshot.attempt ?? 0,
            window: snapshot.window ?? 0, roomGeneration: snapshot.roomGeneration }
          if (scope === answerScope(latest.current ?? snapshot)) {
            receipt.current = accepted
            setAnswerReceipt(accepted)
          }
        }
      } catch (error) {
        if (attempt !== lifecycle.current) throw error
        if (error instanceof SocketAckError && (error.code === 'timeout' || error.code === 'duplicate_answer')) {
          uncertainScope.current = scope
          await synchronizeRef.current()
          if (attempt !== lifecycle.current) throw error
          if (scope === answerScope(latest.current) && hasAnswer(latest.current, receipt.current)) return
          if (uncertainScope.current) {
            setReconnectError('Your answer may have been submitted. Reconnect to check before retrying.')
            throw new Error('Checking whether your answer was submitted. Do not submit again yet.')
          }
        }
        setSubmitError(error instanceof Error ? error.message : 'Unable to submit your answer')
        throw error
      } finally {
        if (attempt === lifecycle.current) {
          pendingAnswer.current = false
          if (!uncertainScope.current) setSubmitting(false)
        }
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
    answerSubmitted: hasAnswer(snapshot, answerReceipt),
    answerScopeKey: answerScope(snapshot),
    submitAnswer,
    submitWager,
    submitSpecialVote,
    submitting,
    submitError,
  }
}
