import type { FastifyInstance } from 'fastify'
import { TLSSocket } from 'node:tls'
import { Server } from 'socket.io'
import type { GameEngine } from './game/engine.js'
import type { RoomRecord } from './game/types.js'
import type { RoomRepository } from './repositories/rooms.js'
import { allowedRequestOrigin } from './publicAccess.js'
type Ack = (result: {
  ok: true
  data?: unknown
} | {
  ok: false
  error: string
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
  const pendingHostSnapshots = new Map<string, NodeJS.Timeout>()
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
  async function sendSnapshots(roomId: string): Promise<void> {
    return engine.runRoom(roomId, async () => {
      const pendingHostSnapshot = pendingHostSnapshots.get(roomId)
      if (pendingHostSnapshot) {
        clearTimeout(pendingHostSnapshot)
        pendingHostSnapshots.delete(roomId)
      }
      const room = (await rooms.getById(roomId))
      if (!room)
        return
      io.to(`room:${room.id}`).emit('room:snapshot', (await engine.publicSnapshot(room)))
      emitHostSnapshot(room.id, await engine.hostSnapshot(room))
    })
  }
  function queueHostSnapshot(roomId: string): void {
    if (pendingHostSnapshots.has(roomId))
      return
    const timer = setTimeout(() => {
      pendingHostSnapshots.delete(roomId)
      void engine.runRoom(roomId, async () => {
        const room = await rooms.getById(roomId)
        if (room) emitHostSnapshot(room.id, await engine.hostSnapshot(room))
      }).catch((error: unknown) => app.log.error({ err: error }, 'Host snapshot failed'))
    }, 50)
    timer.unref()
    pendingHostSnapshots.set(roomId, timer)
  }
  const broadcast = (roomId: string) => {
    void sendSnapshots(roomId).catch((error: unknown) => app.log.error({ err: error }, 'Snapshot broadcast failed'))
  }
  engine.on('roomUpdated', broadcast)
  engine.on('hostUpdated', queueHostSnapshot)
  app.addHook('preClose', async () => {
    for (const timer of pendingHostSnapshots.values())
      clearTimeout(timer)
    pendingHostSnapshots.clear()
    engine.off('roomUpdated', broadcast)
    engine.off('hostUpdated', queueHostSnapshot)
    await new Promise<void>((resolve) => io.close(() => resolve()))
  })
  io.on('connection', (socket) => {
    function handle(ack: Ack, action: () => Promise<unknown>, serialize = true, requestId?: string): void {
      const execute = (async () => {
        if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)))
          throw new Error('Invalid request ID')
        if (serialize && rooms.mode === 'cloud' && !requestId) throw new Error('A request ID is required')
        const operationId = requestId ? `${socket.data.role}:${socket.data.playerId ?? 'host'}:${requestId}` : undefined
        return serialize && typeof socket.data.roomId === 'string'
          ? engine.runRoom(socket.data.roomId, action, operationId)
          : action()
      })()
      void execute.then((data) => {
        if (typeof ack === 'function') ack({ ok: true, data })
      }, (error: unknown) => {
        if (typeof ack === 'function') ack({ ok: false, error: error instanceof Error ? error.message : 'Unexpected error' })
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
        socket.data.roomId = room.id
        socket.data.role = 'host'
        socket.data.hostToken = payload.hostToken
        socket.data.roomRef = room.ref
        void socket.join([`room:${room.id}`, `host:${room.id}`])
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
            socket.data.roomId = current.id
            socket.data.roomRef = current.ref
            socket.data.playerId = joined.player.id
            socket.data.role = 'player'
            void socket.join(`room:${current.id}`)
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
        if (!payload.playerId || !payload.reconnectToken)
          throw new Error('Reconnect token is required')
        const player = (await rooms.reconnect(room, payload.playerId, payload.reconnectToken))
        if (!player)
          throw new Error('Unable to reconnect')
        socket.data.roomId = room.id
        socket.data.roomRef = room.ref
        socket.data.playerId = player.id
        socket.data.role = 'player'
        void socket.join(`room:${room.id}`)
        await sendSnapshots(room.id)
        return (await engine.publicSnapshot(room))
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
            return (await engine.hostSnapshot((await engine.startGame(room))))
          case 'startFinal':
            return (await engine.hostSnapshot((await engine.startFinalRound(room))))
          case 'startFinalQuestion':
            return (await engine.hostSnapshot((await engine.startFinalQuestion(room))))
          case 'selectClue':
            if (!payload.clueId)
              throw new Error('A clue is required')
            return (await engine.hostSnapshot((await engine.selectClue(room, payload.clueId))))
          case 'openAnswers':
            return (await engine.hostSnapshot((await engine.openAnswers(room))))
          case 'resolveSpecialVote':
            return (await engine.hostSnapshot((await engine.resolveSpecialVote(room))))
          case 'closeAnswers':
            return (await engine.hostSnapshot((await engine.closeAnswers(room))))
          case 'reveal':
            return (await engine.hostSnapshot((await engine.reveal(room))))
          case 'leaderboard':
            return (await engine.hostSnapshot((await engine.showLeaderboard(room))))
          case 'board':
            return (await engine.hostSnapshot((await engine.returnToBoard(room))))
          case 'goBack':
            return (await engine.hostSnapshot((await engine.goBack(room))))
          case 'resetClue': {
            const reset = (await engine.resetClue(room))
            if ((await engine.publicSnapshot(reset)).activeClue?.mediaUrl) {
              engine.afterCommit(() => io.to(`room:${room.id}`).emit('media:replay', {
                clueId: reset.state.activeClueId,
              }))
            }
            return (await engine.hostSnapshot(reset))
          }
          case 'skip':
            return (await engine.hostSnapshot((await engine.skipClue(room))))
          case 'replay':
            if (!room.state.activeClueId)
              throw new Error('No clue is selected')
            if (!(await engine.publicSnapshot(room)).activeClue?.mediaUrl) {
              throw new Error('This clue has no audio to replay')
            }
            engine.afterCommit(() => io.to(`room:${room.id}`).emit('media:replay', {
              clueId: room.state.activeClueId,
            }))
            return
          case 'pause':
            return (await engine.hostSnapshot((await engine.pause(room))))
          case 'resume':
            return (await engine.hostSnapshot((await engine.resume(room))))
          case 'finish':
            return (await engine.hostSnapshot((await engine.finish(room))))
          case 'end':
            return (await engine.hostSnapshot((await engine.endSession(room))))
          case 'lock':
            await rooms.setJoiningLocked(room.id, Boolean(payload.locked))
            engine.afterCommit(() => broadcast(room.id))
            return
          case 'kick':
            if (!payload.playerId || !(await rooms.kickPlayer(room.id, payload.playerId))) {
              throw new Error('Player not found')
            }
            engine.afterCommit(() => io.to(`room:${room.id}`).emit('player:kicked', { playerId: payload.playerId }))
            if (room.state.phase === 'SPECIAL_VOTE' &&
              (await rooms.listPlayers(room.id)).length === 1) {
              await engine.resolveSpecialVote(room)
            }
            engine.afterCommit(() => broadcast(room.id))
            return
          case 'adjustScore':
            if (!payload.playerId || typeof payload.delta !== 'number' || !payload.reason) {
              throw new Error('Player, score delta, and reason are required')
            }
            await engine.adjustScore(room, payload.playerId, payload.delta, payload.reason)
            return
          default:
            throw new Error('Unknown host command')
        }
      }, true, payload?.requestId)
    })
    socket.on('disconnect', () => {
      if (typeof socket.data.playerId === 'string' && typeof socket.data.roomId === 'string') {
        const playerId = socket.data.playerId as string
        const roomId = socket.data.roomId as string
        void engine.runRoom(roomId, async () => {
          await rooms.setConnected(playerId, false)
          engine.afterCommit(() => broadcast(roomId))
        }).catch((error: unknown) => app.log.error({ err: error }, 'Disconnect persistence failed'))
      }
    })
    async function requireRoom(code: string | undefined): Promise<RoomRecord> {
      if (!code)
        throw new Error('Room code is required')
      const room = (await rooms.getByCode(code))
      if (!room)
        throw new Error('Room not found')
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
