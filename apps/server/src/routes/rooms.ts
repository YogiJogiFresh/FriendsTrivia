import type { FastifyInstance } from 'fastify'

import type { GameEngine } from '../game/engine.js'
import type { GameSettings, SpecialType } from '../game/types.js'
import type { RoomRepository } from '../repositories/rooms.js'

const defaultSettings: GameSettings = {
  timerSeconds: 30,
  speedBonusMax: 500,
  priceRankPercentages: [1, 0.75, 0.5, 0.25],
  uniqueNicknames: true,
  teams: [],
  specials: [],
}

const supportedSpecials = new Set<SpecialType>([
  'double_points',
  'double_or_nothing',
  'speed_round',
])

export async function registerRoomRoutes(
  app: FastifyInstance,
  rooms: RoomRepository,
  engine: GameEngine,
  codeLength: number,
  getJoinBaseUrl: (requestHost: string) => string,
): Promise<void> {
  function authorizeHost(code: string, authorization: string | undefined) {
    const room = rooms.getByCode(code)
    if (!room) throw new Error('ROOM_NOT_FOUND')
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!token || !rooms.isHost(room, token)) throw new Error('HOST_AUTH_FAILED')
    return room
  }

  app.post('/api/rooms', async (request, reply) => {
    const body = request.body as { packId?: unknown; settings?: Partial<GameSettings> } | undefined
    if (!body || typeof body.packId !== 'string') {
      return reply.code(400).send({ error: 'A pack is required' })
    }
    const settings = { ...defaultSettings, ...body.settings }
    if (
      !Number.isInteger(settings.timerSeconds) ||
      settings.timerSeconds < 5 ||
      settings.timerSeconds > 300 ||
      !Number.isInteger(settings.speedBonusMax) ||
      settings.speedBonusMax < 0 ||
      !Array.isArray(settings.priceRankPercentages)
    ) {
      return reply.code(400).send({ error: 'Invalid game settings' })
    }
    if (
      !Array.isArray(settings.teams) ||
      settings.teams.length > 8 ||
      (settings.teams.length === 1) ||
      settings.teams.some(
        (team) => typeof team !== 'string' || !team.trim() || team.trim().length > 30,
      ) ||
      new Set(settings.teams.map((team) => team.trim().toLocaleLowerCase())).size !==
        settings.teams.length
    ) {
      return reply.code(400).send({ error: 'Use either no teams or 2-8 uniquely named teams' })
    }
    settings.teams = settings.teams.map((team) => team.trim())
    if (
      !Array.isArray(settings.specials) ||
      settings.specials.some((special) => !supportedSpecials.has(special)) ||
      new Set(settings.specials).size !== settings.specials.length
    ) {
      return reply.code(400).send({ error: 'Choose each supported special at most once' })
    }

    try {
      const created = rooms.create(body.packId, settings, codeLength)
      const baseUrl = getJoinBaseUrl(request.headers.host ?? '')
      return reply.code(201).send({
        roomCode: created.room.code,
        hostToken: created.hostToken,
        joinUrl: `${baseUrl}/play/${created.room.code}`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create room'
      return reply.code(message === 'Pack not found' ? 404 : 400).send({ error: message })
    }
  })

  app.get<{ Params: { code: string } }>('/api/rooms/:code', async (request, reply) => {
    const room = rooms.getByCode(request.params.code)
    return room
      ? engine.publicSnapshot(room)
      : reply.code(404).send({ error: 'Room not found' })
  })

  app.get<{ Params: { code: string } }>('/api/rooms/:code/host-session', async (request, reply) => {
    try {
      const room = authorizeHost(request.params.code, request.headers.authorization)
      return {
        code: room.code,
        status: room.status,
        phase: room.state.phase,
        playerCount: rooms.listPlayers(room.id).length,
        updatedAt: room.updatedAt,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return reply
        .code(message === 'ROOM_NOT_FOUND' ? 404 : 401)
        .send({ error: message === 'ROOM_NOT_FOUND' ? 'Room not found' : 'Host authorization failed' })
    }
  })

  app.post<{ Params: { code: string } }>('/api/rooms/:code/end', async (request, reply) => {
    try {
      const room = authorizeHost(request.params.code, request.headers.authorization)
      const ended = engine.endSession(room)
      return {
        code: ended.code,
        status: ended.status,
        phase: ended.state.phase,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return reply
        .code(message === 'ROOM_NOT_FOUND' ? 404 : 401)
        .send({ error: message === 'ROOM_NOT_FOUND' ? 'Room not found' : 'Host authorization failed' })
    }
  })
}
