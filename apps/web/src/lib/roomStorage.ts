/**
 * Small localStorage-backed helpers for the two secrets the server hands
 * out that must survive a page reload: a host's `hostToken` (returned once
 * from `POST /api/rooms`) and a player's `{playerId, reconnectToken}` pair
 * (returned once from the `player:join` socket ack). Keyed by room code so
 * multiple rooms can be host/played across browser tabs without colliding.
 */

const hostTokenKey = (roomCode: string) => `friends-trivia:host-token:${roomCode.toUpperCase()}`
const playerKey = (roomCode: string) => `friends-trivia:player:${roomCode.toUpperCase()}`
const hostTokenPrefix = 'friends-trivia:host-token:'

export function saveHostToken(roomCode: string, hostToken: string): void {
  window.localStorage.setItem(hostTokenKey(roomCode), hostToken)
}

export function getHostToken(roomCode: string): string | null {
  return window.localStorage.getItem(hostTokenKey(roomCode))
}

export function clearHostToken(roomCode: string): void {
  window.localStorage.removeItem(hostTokenKey(roomCode))
}

export function listHostSessions(): Array<{ roomCode: string; hostToken: string }> {
  const sessions: Array<{ roomCode: string; hostToken: string }> = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (!key?.startsWith(hostTokenPrefix)) continue
    const hostToken = window.localStorage.getItem(key)
    if (hostToken) sessions.push({ roomCode: key.slice(hostTokenPrefix.length), hostToken })
  }
  return sessions
}

export interface StoredPlayerIdentity {
  playerId: string
  reconnectToken: string
  nickname: string
}

export function savePlayerIdentity(roomCode: string, identity: StoredPlayerIdentity): void {
  window.localStorage.setItem(playerKey(roomCode), JSON.stringify(identity))
}

export function getPlayerIdentity(roomCode: string): StoredPlayerIdentity | null {
  const raw = window.localStorage.getItem(playerKey(roomCode))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPlayerIdentity>
    if (typeof parsed.playerId === 'string' && typeof parsed.reconnectToken === 'string' && typeof parsed.nickname === 'string') {
      return { playerId: parsed.playerId, reconnectToken: parsed.reconnectToken, nickname: parsed.nickname }
    }
  } catch {
    // Ignore malformed storage and treat it as absent.
  }
  return null
}

export function clearPlayerIdentity(roomCode: string): void {
  window.localStorage.removeItem(playerKey(roomCode))
}
