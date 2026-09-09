import type { FastifyInstance } from 'fastify'
import { Server } from 'socket.io'

import type { GameEngine } from './game/engine.js'
import type { RoomRecord } from './game/types.js'
import type { RoomRepository } from './repositories/rooms.js'

type Ack = (result: { ok: true; data?: unknown } | { ok: false; error: string }) => void

export function registerSocketServer(
  app: FastifyInstance,
  rooms: RoomRepository,
  engine: GameEngine,
): Server {
  const io = new Server(app.server, {
    cors: { origin: false },
    maxHttpBufferSize: 100_000,
  })

  function sendSnapshots(roomId: string): void {
    const room = rooms.getById(roomId)
    if (!room) return
    io.to(`room:${room.id}`).emit('room:snapshot', engine.publicSnapshot(room))
    io.to(`host:${room.id}`).emit('host:snapshot', engine.hostSnapshot(room))
  }

  engine.on('roomUpdated', sendSnapshots)

  io.on('connection', (socket) => {
    const lastEventAt = new Map<string, number>()
    const enforceInterval = (event: string, minimumMs: number) => {
      const now = Date.now()
      const previous = lastEventAt.get(event) ?? 0
      if (now - previous < minimumMs) throw new Error('Too many requests; try again shortly')
      lastEventAt.set(event, now)
    }

    socket.on('room:watch', (payload: { code?: string }, ack: Ack) => {
      handle(ack, () => {
        const room = requireRoom(payload.code)
        void socket.join(`room:${room.id}`)
        return engine.publicSnapshot(room)
      })
    })

    socket.on('host:connect', (payload: { code?: string; hostToken?: string }, ack: Ack) => {
      handle(ack, () => {
        const room = requireRoom(payload.code)
        if (!payload.hostToken || !rooms.isHost(room, payload.hostToken)) {
          throw new Error('Host authorization failed')
        }
        socket.data.roomId = room.id
        socket.data.role = 'host'
        void socket.join([`room:${room.id}`, `host:${room.id}`])
        return engine.hostSnapshot(room)
      })
    })

    socket.on('player:join', (payload: { code?: string; nickname?: string; teamName?: string }, ack: Ack) => {
      handle(ack, () => {
        enforceInterval('player:join', 1_000)
        const room = requireRoom(payload.code)
        const nickname = payload.nickname?.trim()
        if (!nickname || nickname.length > 24) throw new Error('Nickname must be 1-24 characters')
        const joined = rooms.join(room, nickname, payload.teamName)
        socket.data.roomId = room.id
        socket.data.playerId = joined.player.id
        socket.data.role = 'player'
        void socket.join(`room:${room.id}`)
        sendSnapshots(room.id)
        return {
          playerId: joined.player.id,
          reconnectToken: joined.reconnectToken,
          snapshot: engine.publicSnapshot(room),
        }
      })
    })

    socket.on(
      'player:reconnect',
      (payload: { code?: string; playerId?: string; reconnectToken?: string }, ack: Ack) => {
        handle(ack, () => {
          const room = requireRoom(payload.code)
          if (!payload.playerId || !payload.reconnectToken) throw new Error('Reconnect token is required')
          const player = rooms.reconnect(room, payload.playerId, payload.reconnectToken)
          if (!player) throw new Error('Unable to reconnect')
          socket.data.roomId = room.id
          socket.data.playerId = player.id
          socket.data.role = 'player'
          void socket.join(`room:${room.id}`)
          sendSnapshots(room.id)
          return engine.publicSnapshot(room)
        })
      },
    )

    socket.on(
      'player:answer',
      (payload: { answer?: unknown; expectedStateVersion?: number }, ack: Ack) => {
      handle(ack, () => {
        enforceInterval('player:answer', 250)
        const room = requireSocketRoom()
        assertExpectedVersion(room, payload.expectedStateVersion)
        if (socket.data.role !== 'player' || typeof socket.data.playerId !== 'string') {
          throw new Error('Player authorization required')
        }
        return engine.submitAnswer(room, socket.data.playerId, payload.answer)
      })
    },
    )

    socket.on(
      'player:wager',
      (payload: { amount?: number; expectedStateVersion?: number }, ack: Ack) => {
        handle(ack, () => {
          enforceInterval('player:wager', 250)
          const room = requireSocketRoom()
          assertExpectedVersion(room, payload.expectedStateVersion)
          if (socket.data.role !== 'player' || typeof socket.data.playerId !== 'string') {
            throw new Error('Player authorization required')
          }
          if (typeof payload.amount !== 'number') throw new Error('A wager is required')
          engine.submitFinalWager(room, socket.data.playerId, payload.amount)
        })
      },
    )

    socket.on(
      'player:special-vote',
      (payload: { playerId?: string; expectedStateVersion?: number }, ack: Ack) => {
        handle(ack, () => {
          enforceInterval('player:special-vote', 250)
          const room = requireSocketRoom()
          if (socket.data.role !== 'player' || typeof socket.data.playerId !== 'string') {
            throw new Error('Player authorization required')
          }
          if (!payload.playerId) throw new Error('Choose a player')
          return engine.submitSpecialVote(room, socket.data.playerId, payload.playerId)
        })
      },
    )

    socket.on(
      'host:command',
      (
        payload: {
          command?: string
          clueId?: string
          playerId?: string
          locked?: boolean
          delta?: number
          reason?: string
          expectedStateVersion?: number
        },
        ack: Ack,
      ) => {
        handle(ack, () => {
          enforceInterval('host:command', 100)
          const room = requireSocketRoom()
          assertExpectedVersion(room, payload.expectedStateVersion)
          if (socket.data.role !== 'host') throw new Error('Host authorization required')
          switch (payload.command) {
            case 'start':
              return engine.hostSnapshot(engine.startGame(room))
            case 'startFinal':
              return engine.hostSnapshot(engine.startFinalRound(room))
            case 'startFinalQuestion':
              return engine.hostSnapshot(engine.startFinalQuestion(room))
            case 'selectClue':
              if (!payload.clueId) throw new Error('A clue is required')
              return engine.hostSnapshot(engine.selectClue(room, payload.clueId))
            case 'openAnswers':
              return engine.hostSnapshot(engine.openAnswers(room))
            case 'resolveSpecialVote':
              return engine.hostSnapshot(engine.resolveSpecialVote(room))
            case 'closeAnswers':
              return engine.hostSnapshot(engine.closeAnswers(room))
            case 'reveal':
              return engine.hostSnapshot(engine.reveal(room))
            case 'leaderboard':
              return engine.hostSnapshot(engine.showLeaderboard(room))
            case 'board':
              return engine.hostSnapshot(engine.returnToBoard(room))
            case 'goBack':
              return engine.hostSnapshot(engine.goBack(room))
            case 'resetClue': {
              const reset = engine.resetClue(room)
              if (engine.publicSnapshot(reset).activeClue?.mediaUrl) {
                io.to(`room:${room.id}`).emit('media:replay', {
                  clueId: reset.state.activeClueId,
                })
              }
              return engine.hostSnapshot(reset)
            }
            case 'skip':
              return engine.hostSnapshot(engine.skipClue(room))
            case 'replay':
              if (!room.state.activeClueId) throw new Error('No clue is selected')
              if (
                !engine.publicSnapshot(room).activeClue?.mediaUrl
              ) {
                throw new Error('This clue has no audio to replay')
              }
              io.to(`room:${room.id}`).emit('media:replay', {
                clueId: room.state.activeClueId,
              })
              return
            case 'pause':
              return engine.hostSnapshot(engine.pause(room))
            case 'resume':
              return engine.hostSnapshot(engine.resume(room))
            case 'finish':
              return engine.hostSnapshot(engine.finish(room))
            case 'end':
              return engine.hostSnapshot(engine.endSession(room))
            case 'lock':
              rooms.setJoiningLocked(room.id, Boolean(payload.locked))
              sendSnapshots(room.id)
              return
            case 'kick':
              if (!payload.playerId || !rooms.kickPlayer(room.id, payload.playerId)) {
                throw new Error('Player not found')
              }
              io.to(`room:${room.id}`).emit('player:kicked', { playerId: payload.playerId })
              if (
                room.state.phase === 'SPECIAL_VOTE' &&
                rooms.listPlayers(room.id).length === 1
              ) {
                engine.resolveSpecialVote(room)
              }
              sendSnapshots(room.id)
              return
            case 'adjustScore':
              if (!payload.playerId || typeof payload.delta !== 'number' || !payload.reason) {
                throw new Error('Player, score delta, and reason are required')
              }
              engine.adjustScore(room, payload.playerId, payload.delta, payload.reason)
              return
            default:
              throw new Error('Unknown host command')
          }
        })
      },
    )

    socket.on('disconnect', () => {
      if (typeof socket.data.playerId === 'string' && typeof socket.data.roomId === 'string') {
        rooms.setConnected(socket.data.playerId, false)
        sendSnapshots(socket.data.roomId)
      }
    })

    function requireRoom(code: string | undefined): RoomRecord {
      if (!code) throw new Error('Room code is required')
      const room = rooms.getByCode(code)
      if (!room) throw new Error('Room not found')
      return room
    }

    function requireSocketRoom(): RoomRecord {
      if (typeof socket.data.roomId !== 'string') throw new Error('Join a room first')
      const room = rooms.getById(socket.data.roomId)
      if (!room) throw new Error('Room not found')
      return room
    }

    function assertExpectedVersion(room: RoomRecord, expected: number | undefined): void {
      if (expected !== undefined && expected !== room.stateVersion) {
        throw new Error('Room state changed; refresh and try again')
      }
    }
  })

  function handle(ack: Ack, action: () => unknown): void {
    try {
      ack({ ok: true, data: action() })
    } catch (error) {
      ack({ ok: false, error: error instanceof Error ? error.message : 'Unexpected error' })
    }
  }

  return io
}
