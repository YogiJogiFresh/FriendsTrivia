import { z } from 'zod'
import {
  AnswerAcknowledgementSchema,
  AnswerPayloadSchema,
  EntityIdSchema,
  EpochMillisecondsSchema,
  HostRoomSnapshotSchema,
  RequestIdSchema,
  RoomCodeSchema,
  RoomPublicSnapshotSchema,
  StableKeySchema,
} from './contracts.js'

const HostCredentialSchema = z
  .object({
    roomCode: RoomCodeSchema,
    hostToken: z.string().min(32).max(512),
  })
  .strict()

const HostCommandBase = {
  requestId: RequestIdSchema,
  expectedStateVersion: z.number().int().nonnegative(),
} as const

export const ClientEventSchemas = {
  'room:watch': z
    .object({
      roomCode: RoomCodeSchema,
    })
    .strict(),
  'host:authenticate': HostCredentialSchema,
  'player:join': z
    .object({
      requestId: RequestIdSchema,
      roomCode: RoomCodeSchema,
      nickname: z.string().trim().min(1).max(40),
      teamName: z.string().trim().min(1).max(30).optional(),
    })
    .strict(),
  'player:reconnect': z
    .object({
      requestId: RequestIdSchema,
      roomCode: RoomCodeSchema,
      playerId: EntityIdSchema,
      reconnectToken: z.string().min(32).max(512),
    })
    .strict(),
  'player:submit-answer': z
    .object({
      requestId: RequestIdSchema,
      expectedStateVersion: z.number().int().nonnegative(),
      answer: AnswerPayloadSchema,
    })
    .strict(),
  'player:submit-wager': z
    .object({
      requestId: RequestIdSchema,
      expectedStateVersion: z.number().int().nonnegative(),
      amount: z.number().int().nonnegative(),
    })
    .strict(),
  'player:submit-special-vote': z
    .object({
      requestId: RequestIdSchema,
      playerId: EntityIdSchema,
    })
    .strict(),
  'host:set-lock': z
    .object({
      ...HostCommandBase,
      locked: z.boolean(),
    })
    .strict(),
  'host:kick-player': z
    .object({
      ...HostCommandBase,
      playerId: EntityIdSchema,
    })
    .strict(),
  'host:start-game': z.object(HostCommandBase).strict(),
  'host:start-final-round': z.object(HostCommandBase).strict(),
  'host:start-final-question': z.object(HostCommandBase).strict(),
  'host:select-clue': z
    .object({
      ...HostCommandBase,
      clueId: EntityIdSchema,
    })
    .strict(),
  'host:open-answers': z.object(HostCommandBase).strict(),
  'host:resolve-special-vote': z.object(HostCommandBase).strict(),
  'host:pause': z.object(HostCommandBase).strict(),
  'host:resume': z.object(HostCommandBase).strict(),
  'host:close-answers': z.object(HostCommandBase).strict(),
  'host:replay-media': z.object(HostCommandBase).strict(),
  'host:skip-clue': z
    .object({
      ...HostCommandBase,
      reason: z.string().trim().min(1).max(300),
      voidScores: z.boolean().default(true),
    })
    .strict(),
  'host:reveal': z.object(HostCommandBase).strict(),
  'host:show-leaderboard': z.object(HostCommandBase).strict(),
  'host:return-to-board': z.object(HostCommandBase).strict(),
  'host:go-back': z.object(HostCommandBase).strict(),
  'host:reset-clue': z.object(HostCommandBase).strict(),
  'host:adjust-score': z
    .object({
      ...HostCommandBase,
      playerId: EntityIdSchema,
      delta: z.number().int().safe().refine((value) => value !== 0, 'Score delta cannot be zero'),
      reason: z.string().trim().min(1).max(300),
    })
    .strict(),
  'host:finish-game': z.object(HostCommandBase).strict(),
} as const satisfies Record<string, z.ZodTypeAny>

export const PlayerCredentialsSchema = z
  .object({
    requestId: RequestIdSchema,
    roomCode: RoomCodeSchema,
    playerId: EntityIdSchema,
    nickname: z.string().trim().min(1).max(40),
    reconnectToken: z.string().min(32).max(512),
  })
  .strict()

export const CommandAcknowledgementSchema = z
  .object({
    requestId: RequestIdSchema,
    ok: z.boolean(),
    stateVersion: z.number().int().nonnegative().optional(),
    code: StableKeySchema.optional(),
    message: z.string().max(300).optional(),
  })
  .strict()

export const SocketErrorSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    code: StableKeySchema,
    message: z.string().min(1).max(300),
    retryable: z.boolean().default(false),
  })
  .strict()

export const ServerEventSchemas = {
  'room:snapshot': RoomPublicSnapshotSchema,
  'host:snapshot': HostRoomSnapshotSchema,
  'player:credentials': PlayerCredentialsSchema,
  'answer:ack': AnswerAcknowledgementSchema,
  'command:ack': CommandAcknowledgementSchema,
  'media:command': z
    .object({
      action: z.enum(['PLAY', 'PAUSE', 'REPLAY', 'STOP']),
      clueId: EntityIdSchema,
      stateVersion: z.number().int().nonnegative(),
      issuedAtMs: EpochMillisecondsSchema,
      seekToSeconds: z.number().finite().nonnegative().optional(),
    })
    .strict(),
  'server:error': SocketErrorSchema,
} as const satisfies Record<string, z.ZodTypeAny>

export type ClientEventName = keyof typeof ClientEventSchemas
export type ServerEventName = keyof typeof ServerEventSchemas

export type ClientEventPayload<Event extends ClientEventName> = z.infer<
  (typeof ClientEventSchemas)[Event]
>
export type ServerEventPayload<Event extends ServerEventName> = z.infer<
  (typeof ServerEventSchemas)[Event]
>

export type ClientToServerEvents = {
  [Event in ClientEventName]: (payload: ClientEventPayload<Event>) => void
}

export type ServerToClientEvents = {
  [Event in ServerEventName]: (payload: ServerEventPayload<Event>) => void
}

export function parseClientEvent<Event extends ClientEventName>(
  event: Event,
  payload: unknown,
): ClientEventPayload<Event> {
  return ClientEventSchemas[event].parse(payload) as ClientEventPayload<Event>
}

export function parseServerEvent<Event extends ServerEventName>(
  event: Event,
  payload: unknown,
): ServerEventPayload<Event> {
  return ServerEventSchemas[event].parse(payload) as ServerEventPayload<Event>
}
