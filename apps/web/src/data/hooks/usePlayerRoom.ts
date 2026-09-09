import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameState } from '../types'
import { emitWithAck, getSocket } from '../../lib/socketClient'
import { clearPlayerIdentity, getPlayerIdentity, savePlayerIdentity } from '../../lib/roomStorage'
import {
  categoriesFromBoard,
  cluesFromSnapshot,
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
  submitAnswer: (answer: string | number) => Promise<void>
  submitWager: (amount: number) => Promise<void>
  submitSpecialVote: (playerId: string) => Promise<void>
  submitting: boolean
  submitError: string | null
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
  const activePlayerIdRef = useRef<string | null>(null)
  const connection = useConnectionStatus()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFatalError(null)
    setNeedsNickname(false)

    const socket = getSocket()
    const stored = getPlayerIdentity(roomCode)

    function applySnapshot(next: RawSnapshot) {
      if (!cancelled) setSnapshot(next)
    }

    function reconnect(identity: { playerId: string; reconnectToken: string; nickname: string }) {
      emitWithAck<RawSnapshot>('player:reconnect', {
        code: roomCode,
        playerId: identity.playerId,
        reconnectToken: identity.reconnectToken,
      })
        .then((next) => {
          if (cancelled) return
          activePlayerIdRef.current = identity.playerId
          setPlayerId(identity.playerId)
          setNickname(identity.nickname)
          applySnapshot(next)
          setLoading(false)
        })
        .catch(() => {
          if (cancelled) return
          clearPlayerIdentity(roomCode)
          setNeedsNickname(true)
          setLoading(false)
        })
    }

    if (stored) {
      reconnect(stored)
    } else {
      emitWithAck<RawSnapshot>('room:watch', { code: roomCode })
        .then((next) => {
          if (cancelled) return
          applySnapshot(next)
          setNeedsNickname(true)
          setLoading(false)
        })
        .catch((error: Error) => {
          if (cancelled) return
          setFatalError(error.message)
          setLoading(false)
        })
    }

    function handleSnapshot(next: RawSnapshot) {
      if (!cancelled && next.code === roomCode) applySnapshot(next)
    }
    function handleKicked(payload: { playerId?: string }) {
      if (!cancelled && payload.playerId === activePlayerIdRef.current) {
        clearPlayerIdentity(roomCode)
        setFatalError('You were removed from this room by the host.')
      }
    }
    function handleReconnectSocket() {
      const current = getPlayerIdentity(roomCode)
      if (current) reconnect(current)
    }

    socket.on('room:snapshot', handleSnapshot)
    socket.on('player:kicked', handleKicked)
    socket.on('connect', handleReconnectSocket)

    return () => {
      cancelled = true
      socket.off('room:snapshot', handleSnapshot)
      socket.off('player:kicked', handleKicked)
      socket.off('connect', handleReconnectSocket)
    }
  }, [roomCode])

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
      setSubmitting(true)
      setSubmitError(null)
      try {
        await emitWithAck('player:answer', { answer, expectedStateVersion: snapshot?.stateVersion })
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Unable to submit your answer')
        throw error
      } finally {
        setSubmitting(false)
      }
    },
    [snapshot?.stateVersion],
  )

  const submitWager = useCallback(
    async (amount: number) => {
      setSubmitting(true)
      setSubmitError(null)
      try {
        await emitWithAck('player:wager', { amount, expectedStateVersion: snapshot?.stateVersion })
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Unable to submit your wager')
        throw error
      } finally {
        setSubmitting(false)
      }
    },
    [snapshot?.stateVersion],
  )

  const submitSpecialVote = useCallback(
    async (targetPlayerId: string) => {
      setSubmitting(true)
      setSubmitError(null)
      try {
        await emitWithAck('player:special-vote', {
          playerId: targetPlayerId,
        })
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Unable to submit your vote')
        throw error
      } finally {
        setSubmitting(false)
      }
    },
    [],
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
        connection,
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
    submitAnswer,
    submitWager,
    submitSpecialVote,
    submitting,
    submitError,
  }
}
