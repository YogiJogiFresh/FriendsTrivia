import { io, type Socket } from 'socket.io-client'
import type { ConnectionState } from '../data/types'

/**
 * Single shared Socket.IO connection for the whole app. Connecting to no URL
 * targets the page's own origin (proxied to the API server on `/socket.io`
 * in dev via `vite.config.ts`, and served from the same origin in a
 * production build where the server hosts the built client).
 */
let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    })
  }
  return socket
}

export type AckResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

export class SocketAckError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

/** Wraps a callback-ack socket emit in a Promise, rejecting on `{ ok: false }`. */
export function newRequestId(): string {
  return (
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  )
}

export function emitWithAck<T = unknown>(event: string, payload: Record<string, unknown>): Promise<T> {
  const requestId = payload.requestId ?? newRequestId()
  const request = { ...payload, requestId }
  return new Promise((resolve, reject) => {
    getSocket()
      .timeout(10_000)
      .emit(event, request, (error: Error | null, result?: AckResult<T>) => {
      if (error) {
        reject(new SocketAckError('The game server did not respond. Check your connection and try again.', 'timeout'))
        return
      }
      if (!result) {
        reject(new SocketAckError('The game server returned an invalid response.'))
        return
      }
      if (result.ok) resolve(result.data)
      else reject(new SocketAckError(result.error, result.code))
      })
  })
}

type ConnectionListener = (state: ConnectionState) => void

/**
 * Subscribes to the shared socket's low-level connection lifecycle and
 * reports it as the same `ConnectionState` union used by the UI's
 * connection pill / reconnect banner. Returns an unsubscribe function.
 */
export function subscribeConnectionState(listener: ConnectionListener): () => void {
  const client = getSocket()
  let everConnected = false

  const report = (state: ConnectionState) => listener(state)

  const onConnect = () => {
    everConnected = true
    report('connected')
  }
  const onDisconnect = () => report(everConnected ? 'reconnecting' : 'connecting')
  const onReconnectAttempt = () => report('reconnecting')
  const onReconnectFailed = () => report('offline')

  client.on('connect', onConnect)
  client.on('disconnect', onDisconnect)
  client.io.on('reconnect_attempt', onReconnectAttempt)
  client.io.on('reconnect_failed', onReconnectFailed)

  report(client.connected ? 'connected' : 'connecting')

  return () => {
    client.off('connect', onConnect)
    client.off('disconnect', onDisconnect)
    client.io.off('reconnect_attempt', onReconnectAttempt)
    client.io.off('reconnect_failed', onReconnectFailed)
  }
}
