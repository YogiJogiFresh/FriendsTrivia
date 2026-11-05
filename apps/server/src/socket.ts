import type { FastifyInstance } from 'fastify'
import { TLSSocket } from 'node:tls'
import { Server, type Socket } from 'socket.io'
import { DomainError, type RoomRef } from './domain.js'
import { createToken, hashToken, tokenMatches } from './ids.js'
import type { GameEngine } from './game/engine.js'
import type { RoomRecord } from './game/types.js'
import type { RoomRepository } from './repositories/rooms.js'
import { allowedRequestOrigin } from './publicAccess.js'
import { diagnose, diagnosticStage } from './diagnostics.js'
type Ack = (result: {
  ok: true
  data?: unknown
} | {
  ok: false
  error: string
  code?: string
}) => void
export function registerSocketServer(app: FastifyInstance, rooms: RoomRepository, engine: GameEngine, publicUrl?: string): Server {
  const io = new Server(app.server, {
    cors: { origin: false },
    maxHttpBufferSize: 100000,
    allowRequest: (request, callback) => {
      const protocol = request.socket instanceof TLSSocket ? 'https' : 'http'
      const allowed = allowedRequestOrigin(request.headers, publicUrl, protocol) ||
        (rooms.mode === 'local' && allowedRequestOrigin(request.headers, undefined, protocol))
      if (!allowed) app.log.warn('Cross-origin socket connection rejected')
      callback(allowed ? null : 'Cross-origin socket connections are not allowed', allowed)
    },
  })
  interface PendingSnapshot { timer?: NodeJS.Timeout; full: boolean; running: boolean; dirty: boolean; queuedAt: number }
  const pendingSnapshots = new Map<string, PendingSnapshot>()
  let stopping = false
  const playerSockets = new Map<string, string>()
  const seatKey = (ref: RoomRef, playerId: string) => `${ref.id}:${ref.generation}:${playerId}`
  interface RecoveryRequest {
    id: string; ref: RoomRef; playerId: string; nickname: string; teamName: string | null; score: number
    requesterId: string; reconnectToken: string; expiresAt: string; approved: boolean; timer: NodeJS.Timeout
  }
  const recoveryRequests = new Map<string, RecoveryRequest>()
  const requestView = (request: RecoveryRequest) => ({
    id: request.id, playerId: request.playerId, nickname: request.nickname, teamName: request.teamName,
    score: request.score, expiresAt: request.expiresAt, status: request.approved ? 'approved' : 'pending',
  })
  function sendRecoveryRequests(roomId: string): void {
    const requests = [...recoveryRequests.values()].filter((request) => request.ref.id === roomId && !request.approved)
    for (const socketId of io.sockets.adapter.rooms.get(`host:${roomId}`) ?? []) {
      const host = io.sockets.sockets.get(socketId)
      if (host?.data.role === 'host' && host.data.roomId === roomId && typeof host.data.hostToken === 'string')
        host.emit('host:recovery-requests', requests.filter((request) =>
          request.ref.generation === host.data.roomRef?.generation).map(requestView))
    }
  }
  function removeRequest(request: RecoveryRequest, status: string): void {
    if (recoveryRequests.get(request.id) !== request) return
    clearTimeout(request.timer)
    recoveryRequests.delete(request.id)
    io.sockets.sockets.get(request.requesterId)?.emit('player:recovery-state', { ...requestView(request), status })
    sendRecoveryRequests(request.ref.id)
  }
  function liveOwner(ref: RoomRef, playerId: string): string | undefined {
    const owner = playerSockets.get(seatKey(ref, playerId))
    const socket = owner ? io.sockets.sockets.get(owner) : undefined
    return socket?.connected && socket.data.role === 'player' && socket.data.playerId === playerId &&
      socket.data.roomId === ref.id && socket.data.roomRef?.generation === ref.generation ? owner : undefined
  }
  function disconnectSeat(ref: RoomRef, playerId: string, socketId: string): void {
    const key = seatKey(ref, playerId)
    void engine.runRoom(ref.id, async () => {
      const owner = playerSockets.get(key)
      if (owner && owner !== socketId) return
      const room = (await rooms.getById(ref.id))!
      if (room.ref.generation !== ref.generation) return
      await rooms.setConnected(playerId, false)
      engine.afterCommit(() => {
        if (playerSockets.get(key) === socketId) playerSockets.delete(key)
        broadcast(ref.id)
      })
    }).catch((error: unknown) => app.log.error({ err: error }, 'Disconnect persistence failed'))
  }
  function releasePlayer(socket: Socket): void {
    if (socket.data.role === 'player' && socket.data.roomRef && typeof socket.data.playerId === 'string')
      disconnectSeat(socket.data.roomRef as RoomRef, socket.data.playerId, socket.id)
  }
  function bindPlayer(socket: Socket, room: RoomRecord, playerId: string): void {
    if (socket.data.role !== 'player' || socket.data.roomId !== room.id || socket.data.playerId !== playerId) {
      releasePlayer(socket)
      if (typeof socket.data.roomId === 'string') {
        void socket.leave(`room:${socket.data.roomId}`)
        void socket.leave(`host:${socket.data.roomId}`)
      }
    }
    socket.data.roomId = room.id
    socket.data.roomRef = room.ref
    socket.data.playerId = playerId
    socket.data.role = 'player'
    playerSockets.set(seatKey(room.ref, playerId), socket.id)
    void socket.join(`room:${room.id}`)
  }
  function rememberSnapshot(socket: Socket, snapshot: { roomGeneration: string; stateVersion: number; snapshotSequence: number }): void {
    socket.data.publicCursor = { roomGeneration: snapshot.roomGeneration, stateVersion: snapshot.stateVersion,
      snapshotSequence: snapshot.snapshotSequence }
  }
  async function playerSnapshot(room: RoomRecord, playerId: string) {
    return engine.runRoom(room.id, async () => {
      const current = (await rooms.getById(room.id))!
      if (current.ref.generation !== room.ref.generation) throw new DomainError('not_found', 'Room has been replaced')
      const snapshot = await engine.publicSnapshot(current)
      const submission = snapshot.activeClue
        ? await rooms.store.submissionForPlayer(current.ref, {
            clueId: snapshot.activeClue.id, attempt: snapshot.attempt,
          }, playerId)
        : undefined
      return { ...snapshot, ownSubmission: submission ? {
        clueId: snapshot.activeClue!.id, attempt: snapshot.attempt, window: snapshot.window,
        roomGeneration: snapshot.roomGeneration,
      } : undefined }
    })
  }
  function emitHostSnapshot(roomId: string, snapshot: unknown): void {
    for (const socketId of io.sockets.adapter.rooms.get(`host:${roomId}`) ?? []) {
      const socket = io.sockets.sockets.get(socketId)
      if (!socket) continue
      if (socket.data.role === 'host' && socket.data.roomId === roomId &&
        typeof socket.data.hostToken === 'string') {
        socket.emit('host:snapshot', snapshot)
      } else {
        void socket.leave(`host:${roomId}`)
      }
    }
  }
  function scheduleSnapshot(roomId: string, pending: PendingSnapshot): void {
    pending.timer = setTimeout(() => {
      pending.running = true
      const full = pending.full
      pending.full = false
      pending.dirty = false
      void diagnose('broadcast', (trace) => app.log.info({ diagnostic: trace }, 'Game diagnostic'), () => engine.runRoom(roomId, async () => {
        diagnosticStage('coalesce_and_queue_wait', performance.now() - pending.queuedAt)
        const room = await rooms.getById(roomId)
        if (!room) return
        if (['finished', 'abandoned'].includes(room.status))
          for (const request of recoveryRequests.values())
            if (request.ref.id === roomId) removeRequest(request, 'unavailable')
        const hasHost = Boolean(io.sockets.adapter.rooms.get(`host:${roomId}`)?.size)
        if (!hasHost && !io.sockets.adapter.rooms.get(`room:${roomId}`)?.size) return
        if (!full && !hasHost) {
          io.to(`room:${room.id}`).emit('room:answer-progress', await engine.answerProgressSnapshot(room))
          return
        }
        const snapshots = await engine.snapshotPair(room, hasHost)
        if (full) {
          for (const id of io.sockets.adapter.rooms.get(`room:${room.id}`) ?? []) {
            const player = io.sockets.sockets.get(id)
            if (player?.data.role === 'player') rememberSnapshot(player, snapshots.public)
          }
          io.to(`room:${room.id}`).emit('room:snapshot', snapshots.public)
        }
        else {
          const snapshot = snapshots.public
          io.to(`room:${room.id}`).emit('room:answer-progress', {
            code: snapshot.code, roomGeneration: snapshot.roomGeneration,
            stateVersion: snapshot.stateVersion, snapshotSequence: snapshot.snapshotSequence,
            phase: snapshot.phase, clueId: snapshot.activeClue?.id,
            attempt: snapshot.attempt, window: snapshot.window,
            answerProgress: snapshot.answerProgress,
          })
        }
        if (snapshots.host) emitHostSnapshot(room.id, snapshots.host)
        diagnosticStage('emit', 0)
      })).catch((error: unknown) => {
        app.log.error({ err: error }, 'Snapshot broadcast failed')
        if (error instanceof DomainError && error.code === 'not_found')
          for (const request of recoveryRequests.values())
            if (request.ref.id === roomId) removeRequest(request, 'unavailable')
      }).finally(() => {
        pending.running = false
        if (stopping) return
        if (pending.dirty || pending.full) scheduleSnapshot(roomId, pending)
        else pendingSnapshots.delete(roomId)
      })
    }, 50)
    pending.timer.unref()
  }
  function queueSnapshot(roomId: string, full: boolean): void {
    if (stopping) return
    const existing = pendingSnapshots.get(roomId)
    if (existing) {
      existing.full ||= full
      if (existing.running) existing.dirty = true
      return
    }
    const pending: PendingSnapshot = { full, running: false, dirty: false, queuedAt: performance.now() }
    pendingSnapshots.set(roomId, pending)
    scheduleSnapshot(roomId, pending)
  }
  const broadcast = (roomId: string) => queueSnapshot(roomId, true)
  const queueHostSnapshot = (roomId: string) => {
    if (io.sockets.adapter.rooms.get(`host:${roomId}`)?.size ||
      io.sockets.adapter.rooms.get(`room:${roomId}`)?.size) queueSnapshot(roomId, false)
  }
  engine.on('roomUpdated', broadcast)
  engine.on('hostUpdated', queueHostSnapshot)
  app.addHook('preClose', async () => {
    stopping = true
    for (const pending of pendingSnapshots.values()) clearTimeout(pending.timer)
    pendingSnapshots.clear()
    for (const request of recoveryRequests.values()) clearTimeout(request.timer)
    recoveryRequests.clear()
    playerSockets.clear()
    engine.off('roomUpdated', broadcast)
    engine.off('hostUpdated', queueHostSnapshot)
    await new Promise<void>((resolve) => io.close(() => resolve()))
  })
  io.on('connection', (socket) => {
    let reconnecting: { key: string; promise: Promise<Awaited<ReturnType<typeof playerSnapshot>>> } | undefined
    function handle(ack: Ack, action: () => Promise<unknown>, serialize = true, requestId?: string): void {
      const execute = diagnose('socket', (trace) => app.log.info({ diagnostic: trace }, 'Game diagnostic'), async () => {
        if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)))
          throw new Error('Invalid request ID')
        if (serialize && rooms.mode === 'cloud' && !requestId) throw new Error('A request ID is required')
        const operationId = requestId ? `${socket.data.role}:${socket.data.playerId ?? 'host'}:${requestId}` : undefined
        const result = await (serialize && typeof socket.data.roomId === 'string'
          ? engine.runRoom(socket.data.roomId, action, operationId)
          : action())
        diagnosticStage('ack_ready', 0)
        return result
      }, requestId)
      void execute.then((data) => {
        if (typeof ack === 'function') ack({ ok: true, data })
      }, (error: unknown) => {
        if (typeof ack === 'function') ack({ ok: false, error: error instanceof Error ? error.message : 'Unexpected error',
          ...(error instanceof DomainError ? { code: error.code } : {}) })
        else app.log.warn({ err: error }, 'Socket event failed')
      })
    }
    const lastEventAt = new Map<string, number>()
    const enforceInterval = (event: string, minimumMs: number) => {
      const now = Date.now()
      const previous = lastEventAt.get(event) ?? 0
      if (now - previous < minimumMs)
        throw new Error('Too many requests; try again shortly')
      lastEventAt.set(event, now)
    }
    socket.on('room:watch', (payload: {
      code?: string
    }, ack: Ack) => {
      handle(ack, async () => {
        const room = (await requireRoom(payload.code))
        void socket.join(`room:${room.id}`)
        return (await engine.publicSnapshot(room))
      }, false)
    })
    socket.on('host:connect', (payload: {
      code?: string
      hostToken?: string
    }, ack: Ack) => {
      handle(ack, async () => {
        const room = (await requireRoom(payload.code))
        if (!payload.hostToken || !rooms.isHost(room, payload.hostToken)) {
          throw new Error('Host authorization failed')
        }
        releasePlayer(socket)
        socket.data.roomId = room.id
        socket.data.role = 'host'
        socket.data.hostToken = payload.hostToken
        socket.data.roomRef = room.ref
        void socket.join([`room:${room.id}`, `host:${room.id}`])
        sendRecoveryRequests(room.id)
        return (await engine.hostSnapshot(room))
      }, false)
    })
    socket.on('player:join', (payload: {
      code?: string
      nickname?: string
      teamName?: string
    }, ack: Ack) => {
      handle(ack, async () => {
        enforceInterval('player:join', 1000)
        const room = (await requireRoom(payload.code))
        const nickname = payload.nickname?.trim()
        if (!nickname || nickname.length > 24)
          throw new Error('Nickname must be 1-24 characters')
        return engine.runRoom(room.id, async () => {
          const current = (await rooms.getById(room.id))!
          const joined = await rooms.join(current, nickname, payload.teamName)
          const snapshot = await engine.publicSnapshot(current)
          engine.afterCommit(() => {
            if (!socket.connected) {
              disconnectSeat(current.ref, joined.player.id, socket.id)
              return
            }
            bindPlayer(socket, current, joined.player.id)
            rememberSnapshot(socket, snapshot)
            broadcast(current.id)
          })
          return {
            playerId: joined.player.id,
            reconnectToken: joined.reconnectToken,
            snapshot,
          }
        })
      }, false)
    })
    socket.on('player:reconnect', (payload: {
      code?: string
      playerId?: string
      reconnectToken?: string
    }, ack: Ack) => {
      handle(ack, async () => {
        const room = (await requireRoom(payload.code))
        if (typeof payload.playerId !== 'string' || !payload.playerId || payload.playerId.length > 100 ||
          typeof payload.reconnectToken !== 'string' || !payload.reconnectToken || payload.reconnectToken.length > 100)
          throw new DomainError('invalid_identity', 'Reconnect token is required')
        const key = `${room.id}:${room.ref.generation}:${payload.playerId}:${hashToken(payload.reconnectToken)}`
        if (reconnecting) {
          if (reconnecting.key !== key) throw new Error('A reconnect is already pending on this connection')
          return reconnecting.promise
        }
        const promise = engine.runRoom(room.id, async () => {
          const owner = liveOwner(room.ref, payload.playerId!)
          if (owner && owner !== socket.id) throw new DomainError('seat_connected', 'This player is already connected on another connection')
          const player = await rooms.reconnect(room, payload.playerId!, payload.reconnectToken!)
          if (!player) throw new DomainError('invalid_identity', 'Unable to reconnect')
          const snapshot = await playerSnapshot(room, player.id)
          engine.afterCommit(() => {
            if (!socket.connected) {
              disconnectSeat(room.ref, player.id, socket.id)
              return
            }
            bindPlayer(socket, room, player.id)
            rememberSnapshot(socket, snapshot)
            for (const request of recoveryRequests.values())
              if (request.ref.id === room.id && request.playerId === player.id && request.requesterId !== socket.id)
                removeRequest(request, 'unavailable')
            broadcast(room.id)
          })
          return snapshot
        })
        reconnecting = { key, promise }
        try { return await promise }
        finally { if (reconnecting?.promise === promise) reconnecting = undefined }
      }, false)
    })
    socket.on('player:sync', (payload: {
      roomGeneration?: string; stateVersion?: number; snapshotSequence?: number
    }, ack: Ack) => {
      handle(ack, async () => {
        enforceInterval('player:sync', 250)
        const ref = socket.data.roomRef as RoomRef | undefined
        const cursor = socket.data.publicCursor as { roomGeneration: string; stateVersion: number; snapshotSequence: number } | undefined
        return { inSync: Boolean(ref && cursor && socket.data.role === 'player' &&
          ref.generation === payload?.roomGeneration && liveOwner(ref, socket.data.playerId) === socket.id &&
          socket.rooms.has(`room:${ref.id}`) && cursor.roomGeneration === payload.roomGeneration &&
          typeof payload.stateVersion === 'number' && Number.isSafeInteger(payload.stateVersion) &&
          typeof payload.snapshotSequence === 'number' && Number.isSafeInteger(payload.snapshotSequence) &&
          cursor.stateVersion <= payload.stateVersion && cursor.snapshotSequence <= payload.snapshotSequence) }
      }, false)
    })
    socket.on('player:recover-request', (payload: {
      code?: string; nickname?: string; requestId?: string; expectedRoomGeneration?: string
    }, ack: Ack) => {
      handle(ack, async () => {
        enforceInterval('player:recover-request', 1000)
        const room = await requireRoom(payload.code)
        if (socket.data.role === 'player' && socket.data.roomRef &&
          liveOwner(socket.data.roomRef as RoomRef, socket.data.playerId as string) === socket.id)
          throw new DomainError('seat_connected', 'You are already connected to a player seat')
        if (payload.expectedRoomGeneration !== room.ref.generation) throw new DomainError('not_found', 'Room has been replaced')
        if (!payload.requestId) throw new Error('A request ID is required')
        const nickname = payload.nickname?.trim()
        if (!nickname || nickname.length > 24) throw new Error('Nickname must be 1-24 characters')
        return engine.runRoom(room.id, async () => {
          const current = (await rooms.getById(room.id))!
          if (['finished', 'abandoned'].includes(current.status)) throw new DomainError('room_ended', 'This session has ended')
          const player = (await rooms.listPlayers(room.id)).find((player) => player.nickname.trim().toLocaleLowerCase() === nickname.toLocaleLowerCase())
          if (!player || player.kicked) throw new DomainError('invalid_identity', 'No recoverable seat matches that nickname')
          if (player.connected || liveOwner(room.ref, player.id)) throw new DomainError('seat_connected', 'This player is already connected')
          const existing = [...recoveryRequests.values()].find((request) =>
            request.requesterId === socket.id || (request.ref.id === room.id && request.playerId === player.id))
          if (existing) {
            if (existing.requesterId === socket.id && existing.ref.generation === room.ref.generation && existing.playerId === player.id)
              return requestView(existing)
            throw new Error('A recovery request for this seat is already pending')
          }
          if (recoveryRequests.has(payload.requestId!) || recoveryRequests.size >= 200) throw new Error('Too many recovery requests; try again shortly')
          const expiresAt = new Date(Date.now() + 120_000).toISOString()
          const request: RecoveryRequest = {
            id: payload.requestId!, ref: room.ref, playerId: player.id, nickname: player.nickname, teamName: player.teamName,
            score: (await rooms.scores(room.id)).find(({ playerId }) => playerId === player.id)?.score ?? 0,
            requesterId: socket.id, reconnectToken: createToken(), expiresAt, approved: false,
            timer: setTimeout(() => removeRequest(request, 'expired'), 120_000),
          }
          request.timer.unref()
          recoveryRequests.set(request.id, request)
          engine.afterCommit(() => sendRecoveryRequests(room.id))
          return requestView(request)
        })
      }, false, payload?.requestId)
    })
    socket.on('host:recovery-decision', (payload: {
      recoveryId?: string; approved?: boolean; expectedRoomGeneration?: string; requestId?: string
    }, ack: Ack) => {
      handle(ack, async () => {
        const room = await requireSocketRoom()
        if (socket.data.role !== 'host' || typeof socket.data.hostToken !== 'string' || !rooms.isHost(room, socket.data.hostToken))
          throw new Error('Host authorization required')
        if (['finished', 'abandoned'].includes(room.status)) throw new DomainError('room_ended', 'This session has ended')
        if (payload.expectedRoomGeneration !== room.ref.generation) throw new DomainError('not_found', 'Room has been replaced')
        const request = recoveryRequests.get(payload.recoveryId ?? '')
        if (!request || request.ref.id !== room.id || request.ref.generation !== room.ref.generation ||
          Date.parse(request.expiresAt) <= Date.now()) throw new Error('This recovery request has expired')
        if (typeof payload.approved !== 'boolean') throw new Error('An approval decision is required')
        const requester = io.sockets.sockets.get(request.requesterId)
        if (!requester?.connected) throw new Error('The requesting player has disconnected')
        if (!payload.approved) {
          if (request.approved) throw new Error('This recovery was already approved')
          engine.afterCommit(() => removeRequest(request, 'declined'))
          return
        }
        const owner = liveOwner(room.ref, request.playerId)
        if (owner && owner !== requester.id) throw new DomainError('seat_connected', 'This player is already connected')
        const wasApproved = request.approved
        if (wasApproved) {
          const player = await rooms.getPlayer(request.playerId)
          if (owner !== requester.id || !player || player.kicked || !tokenMatches(request.reconnectToken, player.reconnectTokenHash))
            throw new DomainError('invalid_identity', 'This recovery is no longer active')
        } else await rooms.recoverSeat(room, request.playerId, request.reconnectToken)
        const snapshot = await playerSnapshot(room, request.playerId)
        engine.afterCommit(() => {
          if (!requester.connected || recoveryRequests.get(request.id) !== request || Date.parse(request.expiresAt) <= Date.now()) {
            if (!wasApproved) disconnectSeat(room.ref, request.playerId, requester.id)
            return
          }
          request.approved = true
          bindPlayer(requester, room, request.playerId)
          rememberSnapshot(requester, snapshot)
          requester.emit('player:recovery-approved', {
            id: request.id, playerId: request.playerId, reconnectToken: request.reconnectToken, nickname: request.nickname, snapshot,
          })
          sendRecoveryRequests(room.id)
          broadcast(room.id)
        })
      }, true, payload?.requestId)
    })
    socket.on('player:recovery-status', (payload: { recoveryId?: string }, ack: Ack) => {
      handle(ack, async () => {
        const request = recoveryRequests.get(payload.recoveryId ?? '')
        if (!request || request.requesterId !== socket.id || Date.parse(request.expiresAt) <= Date.now())
          throw new Error('This recovery request is no longer available')
        if (request.approved) {
          const room = await requireRoom(request.ref.code)
          if (['finished', 'abandoned'].includes(room.status)) throw new DomainError('room_ended', 'This session has ended')
          if (room.ref.generation !== request.ref.generation || liveOwner(room.ref, request.playerId) !== socket.id)
            throw new Error('This recovery request is no longer available')
          return { ...requestView(request), identity: {
            playerId: request.playerId, reconnectToken: request.reconnectToken, nickname: request.nickname,
            snapshot: await playerSnapshot(room, request.playerId),
          } }
        }
        return requestView(request)
      }, false)
    })
    socket.on('player:recovery-cancel', (payload: { recoveryId?: string }, ack: Ack) => {
      handle(ack, async () => {
        const request = recoveryRequests.get(payload.recoveryId ?? '')
        if (!request || request.requesterId !== socket.id) return
        if (request.approved) {
          disconnectSeat(request.ref, request.playerId, socket.id)
          if (socket.data.playerId === request.playerId && socket.data.roomId === request.ref.id) {
            socket.data.role = undefined
            socket.data.playerId = undefined
          }
        }
        removeRequest(request, 'canceled')
      }, false)
    })
    socket.on('player:answer', (payload: {
      answer?: unknown
      requestId?: string
      expectedRoomGeneration?: string
      expectedAttempt?: number
      expectedWindow?: number
      expectedWagerGeneration?: number
      expectedStateVersion?: number
    }, ack: Ack) => {
      const receivedAtMs = Date.now()
      handle(ack, async () => {
        enforceInterval('player:answer', 250)
        const room = (await requireSocketRoom())
        if (payload.expectedWindow === undefined) assertExpectedVersion(room, payload.expectedStateVersion)
        assertWindow(room, payload, 'answer', rooms.mode === 'cloud')
        if (socket.data.role !== 'player' || typeof socket.data.playerId !== 'string') {
          throw new Error('Player authorization required')
        }
        return (await engine.submitAnswer(room, socket.data.playerId, payload.answer, receivedAtMs))
      }, true, payload?.requestId)
    })
    socket.on('player:wager', (payload: {
      amount?: number
      requestId?: string
      expectedRoomGeneration?: string
      expectedAttempt?: number
      expectedWindow?: number
      expectedWagerGeneration?: number
      expectedStateVersion?: number
    }, ack: Ack) => {
      handle(ack, async () => {
        enforceInterval('player:wager', 250)
        const room = (await requireSocketRoom())
        if (payload.expectedWagerGeneration === undefined) assertExpectedVersion(room, payload.expectedStateVersion)
        assertWindow(room, payload, 'wager', rooms.mode === 'cloud')
        if (socket.data.role !== 'player' || typeof socket.data.playerId !== 'string') {
          throw new Error('Player authorization required')
        }
        if (typeof payload.amount !== 'number')
          throw new Error('A wager is required')
        await engine.submitFinalWager(room, socket.data.playerId, payload.amount)
      }, true, payload?.requestId)
    })
    socket.on('player:special-vote', (payload: {
      playerId?: string
      requestId?: string
      expectedRoomGeneration?: string
      expectedAttempt?: number
      expectedWindow?: number
      expectedWagerGeneration?: number
      expectedStateVersion?: number
    }, ack: Ack) => {
      handle(ack, async () => {
        enforceInterval('player:special-vote', 250)
        const room = (await requireSocketRoom())
        assertWindow(room, payload, 'answer', rooms.mode === 'cloud')
        if (socket.data.role !== 'player' || typeof socket.data.playerId !== 'string') {
          throw new Error('Player authorization required')
        }
        if (!payload.playerId)
          throw new Error('Choose a player')
        return (await engine.submitSpecialVote(room, socket.data.playerId, payload.playerId))
      }, true, payload?.requestId)
    })
    socket.on('host:command', (payload: {
      command?: string
      clueId?: string
      playerId?: string
      locked?: boolean
      delta?: number
      reason?: string
      requestId?: string
      expectedRoomGeneration?: string
      expectedAttempt?: number
      expectedWindow?: number
      expectedWagerGeneration?: number
      expectedStateVersion?: number
    }, ack: Ack) => {
      handle(ack, async () => {
        enforceInterval('host:command', 100)
        const room = (await requireSocketRoom())
        assertExpectedVersion(room, payload.expectedStateVersion)
        assertWindow(room, payload, 'answer', rooms.mode === 'cloud')
        if (socket.data.role !== 'host' || typeof socket.data.hostToken !== 'string' || !rooms.isHost(room, socket.data.hostToken))
          throw new Error('Host authorization required')
        switch (payload.command) {
          case 'start':
            await engine.startGame(room); break
          case 'startFinal':
            await engine.startFinalRound(room); break
          case 'startFinalQuestion':
            await engine.startFinalQuestion(room); break
          case 'selectClue':
            if (!payload.clueId)
              throw new Error('A clue is required')
            await engine.selectClue(room, payload.clueId); break
          case 'openAnswers':
            await engine.openAnswers(room); break
          case 'resolveSpecialVote':
            await engine.resolveSpecialVote(room); break
          case 'closeAnswers':
            await engine.closeAnswers(room); break
          case 'reveal':
            await engine.reveal(room); break
          case 'leaderboard':
            await engine.showLeaderboard(room); break
          case 'board':
            await engine.returnToBoard(room); break
          case 'goBack':
            await engine.goBack(room); break
          case 'resetClue': {
            const reset = (await engine.resetClue(room))
            if ((await engine.publicSnapshot(reset)).activeClue?.mediaUrl) {
              engine.afterCommit(() => io.to(`room:${room.id}`).emit('media:replay', {
                clueId: reset.state.activeClueId,
              }))
            }
            break
          }
          case 'skip':
            await engine.skipClue(room); break
          case 'replay':
            if (!room.state.activeClueId)
              throw new Error('No clue is selected')
            if (!(await engine.publicSnapshot(room)).activeClue?.mediaUrl) {
              throw new Error('This clue has no audio to replay')
            }
            engine.afterCommit(() => io.to(`room:${room.id}`).emit('media:replay', {
              clueId: room.state.activeClueId,
            }))
            break
          case 'pause':
            await engine.pause(room); break
          case 'resume':
            await engine.resume(room); break
          case 'finish':
            await engine.finish(room); break
          case 'end':
            await engine.endSession(room); break
          case 'lock':
            await rooms.setJoiningLocked(room.id, Boolean(payload.locked))
            engine.afterCommit(() => broadcast(room.id))
            break
          case 'kick':
            if (!payload.playerId || !(await rooms.kickPlayer(room.id, payload.playerId))) {
              throw new Error('Player not found')
            }
            engine.afterCommit(() => io.to(`room:${room.id}`).emit('player:kicked', { playerId: payload.playerId }))
            engine.afterCommit(() => {
              for (const request of recoveryRequests.values())
                if (request.ref.id === room.id && request.playerId === payload.playerId) removeRequest(request, 'unavailable')
            })
            if (room.state.phase === 'SPECIAL_VOTE' &&
              (await rooms.listPlayers(room.id)).length === 1) {
              await engine.resolveSpecialVote(room)
            }
            engine.afterCommit(() => broadcast(room.id))
            break
          case 'adjustScore':
            if (!payload.playerId || typeof payload.delta !== 'number' || !payload.reason) {
              throw new Error('Player, score delta, and reason are required')
            }
            await engine.adjustScore(room, payload.playerId, payload.delta, payload.reason)
            break
          default:
            throw new Error('Unknown host command')
        }
        const committedRoom = (await rooms.getById(room.id))!
        diagnosticStage(`host_${payload.command}`, 0)
        const receipt = {} as ReturnType<GameEngine['commandReceipt']>
        engine.afterCommit(() => Object.assign(receipt, engine.commandReceipt(committedRoom)))
        return receipt
      }, true, payload?.requestId)
    })
    socket.on('disconnect', () => {
      for (const request of recoveryRequests.values())
        if (request.requesterId === socket.id) removeRequest(request, 'disconnected')
      if (typeof socket.data.playerId === 'string' && typeof socket.data.roomId === 'string') {
        const playerId = socket.data.playerId as string
        const roomId = socket.data.roomId as string
        const ref = socket.data.roomRef as RoomRef
        disconnectSeat({ ...ref, id: roomId }, playerId, socket.id)
      }
    })
    async function requireRoom(code: string | undefined): Promise<RoomRecord> {
      if (!code)
        throw new Error('Room code is required')
      const room = (await rooms.getByCode(code))
      if (!room)
        throw new DomainError('not_found', 'Room not found')
      return room
    }
    async function requireSocketRoom(): Promise<RoomRecord> {
      if (typeof socket.data.roomId !== 'string')
        throw new Error('Join a room first')
      const room = (await rooms.getById(socket.data.roomId))
      if (!room)
        throw new Error('Room not found')
      const ref = socket.data.roomRef as { generation?: string } | undefined
      if (!ref || ref.generation !== room.ref.generation) throw new Error('Room has been replaced')
      if (socket.data.role === 'player' &&
        liveOwner(room.ref, socket.data.playerId as string) !== socket.id)
        throw new Error('Reconnect to your seat before playing')
      return room
    }
    function assertExpectedVersion(room: RoomRecord, expected: number | undefined): void {
      if (expected !== undefined && expected !== room.stateVersion) {
        throw new Error('Room state changed; refresh and try again')
      }
    }
  })
  return io
}

function assertWindow(room: RoomRecord, payload: { expectedRoomGeneration?: string; expectedAttempt?: number; expectedWindow?: number; expectedWagerGeneration?: number }, kind: 'answer' | 'wager', required: boolean): void {
  const supplied = payload.expectedRoomGeneration !== undefined || payload.expectedAttempt !== undefined || payload.expectedWindow !== undefined || payload.expectedWagerGeneration !== undefined
  if (!supplied && !required) return
  if (payload.expectedRoomGeneration !== room.ref.generation || payload.expectedAttempt !== (room.state.attempt ?? 0) ||
      (kind === 'answer' ? payload.expectedWindow !== (room.state.window ?? 0) : payload.expectedWagerGeneration !== (room.state.wagerGeneration ?? 0)))
    throw new Error('This question has changed; refresh and try again')
}
