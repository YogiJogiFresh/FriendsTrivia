/**
 * Thin REST client for the FriendsTrivia server described in
 * `apps/server/src/routes/*`. Every call goes through `request()` so error
 * surfacing (network failure vs. non-2xx vs. malformed JSON) is consistent
 * everywhere it's used.
 */

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function parseErrorBody(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: unknown }
    if (body && typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Body wasn't JSON — fall through to the status text below.
  }
  return response.statusText || `Request failed with status ${response.status}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('Could not reach the FriendsTrivia server. Check your connection and try again.', 0)
  }

  if (!response.ok) {
    throw new ApiError(await parseErrorBody(response), response.status)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

// ---- Packs -----------------------------------------------------------

export interface ServerPackSummary {
  id: string
  title: string
  description: string
  status: 'draft' | 'ready' | 'archived'
  categoryCount: number
  clueCount: number
  createdAt: string
  updatedAt: string
}

export type ServerClueType = 'music_multiple_choice' | 'music_free_text' | 'price_slider'

export interface ServerClueConfig {
  choices?: string[]
  correctAnswer?: string
  acceptedAnswers?: string[]
  correctPrice?: number
  min?: number
  max?: number
  step?: number
  prefix?: string
  revealGif?: ServerRevealGif
}

export type GifProvider = 'giphy' | 'tenor'

export interface ServerRevealGif {
  provider: GifProvider | 'url'
  url: string
  previewUrl: string
  alt: string
  sourceUrl: string
}

export interface GifSearchResult extends ServerRevealGif {
  id: string
}

export interface GifProviderStatus {
  giphy: boolean
  tenor: boolean
}

export interface ServerClueDetail {
  id: string
  type: ServerClueType
  boardValue: number
  position: number
  prompt: string
  timerSeconds: number
  mediaAssetId: string | null
  revealMediaAssetId: string | null
  finalQuestion: boolean
  config: ServerClueConfig
}

export interface ServerCategoryDetail {
  id: string
  title: string
  position: number
  clues: ServerClueDetail[]
}

export interface ServerPackDetail {
  id: string
  title: string
  description: string
  status: 'draft' | 'ready' | 'archived'
  defaultSettings: unknown
  createdAt: string
  updatedAt: string
  categories: ServerCategoryDetail[]
}

export interface PackInputClue {
  id?: string
  type: ServerClueType
  boardValue: number
  prompt: string
  timerSeconds?: number
  mediaAssetId?: string | null
  revealMediaAssetId?: string | null
  finalQuestion?: boolean
  config: ServerClueConfig
}

export interface PackInputCategory {
  id?: string
  title: string
  clues: PackInputClue[]
}

export interface PackInput {
  title: string
  description?: string
  status?: 'draft' | 'ready' | 'archived'
  defaultSettings?: unknown
  categories: PackInputCategory[]
}

export function listPacks(includeArchived = false): Promise<ServerPackSummary[]> {
  const query = includeArchived ? '?includeArchived=true' : ''
  return request(`/api/packs${query}`)
}

export function getPack(id: string): Promise<ServerPackDetail> {
  return request(`/api/packs/${encodeURIComponent(id)}`)
}

export function createPack(input: { title: string; description?: string }): Promise<ServerPackDetail> {
  return request('/api/packs', json('POST', input))
}

export function savePack(id: string, input: PackInput): Promise<ServerPackDetail> {
  return request(`/api/packs/${encodeURIComponent(id)}`, json('PUT', input))
}

export function deletePack(id: string): Promise<void> {
  return request(`/api/packs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function importPack(manifest: unknown): Promise<ServerPackDetail> {
  return request('/api/packs/import', json('POST', manifest))
}

export function packExportUrl(id: string): string {
  return `/api/packs/${encodeURIComponent(id)}/export`
}

// ---- GIF search ----------------------------------------------------------

export function getGifProviders(): Promise<GifProviderStatus> {
  return request('/api/gifs/providers')
}

export function configureGifProvider(provider: GifProvider, apiKey: string): Promise<void> {
  return request(`/api/gifs/providers/${provider}`, json('PUT', { apiKey }))
}

export function searchGifs(provider: GifProvider, query: string): Promise<{ results: GifSearchResult[] }> {
  const params = new URLSearchParams({ provider, q: query })
  return request(`/api/gifs/search?${params.toString()}`)
}

// ---- Media -------------------------------------------------------------

export interface ServerMediaAsset {
  id: string
  relativePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  durationSeconds: number | null
  createdAt: string
}

export function listMedia(): Promise<ServerMediaAsset[]> {
  return request('/api/media')
}

export function getMediaLibraryInfo(): Promise<{ directory: string }> {
  return request('/api/media/library')
}

export async function uploadMedia(file: File): Promise<ServerMediaAsset> {
  const formData = new FormData()
  formData.append('file', file)
  return request('/api/media', { method: 'POST', body: formData })
}

export function deleteMedia(id: string): Promise<void> {
  return request(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function mediaStreamUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}/stream`
}

// ---- Rooms ---------------------------------------------------------------

export interface CreateRoomResponse {
  roomCode: string
  hostToken: string
  joinUrl: string
}

export interface RoomSettingsInput {
  timerSeconds?: number
  speedBonusMax?: number
  priceRankPercentages?: number[]
  uniqueNicknames?: boolean
  teams?: string[]
}

export function createRoom(packId: string, settings?: RoomSettingsInput): Promise<CreateRoomResponse> {
  return request('/api/rooms', json('POST', { packId, settings }))
}

export function getRoomSnapshot(code: string): Promise<unknown> {
  return request(`/api/rooms/${encodeURIComponent(code)}`)
}

export interface HostedRoomSummary {
  code: string
  status: 'lobby' | 'active' | 'paused' | 'finished' | 'abandoned'
  phase: string
  playerCount: number
  updatedAt: string
}

function hostAuthorization(hostToken: string): Pick<RequestInit, 'headers'> {
  return { headers: { Authorization: `Bearer ${hostToken}` } }
}

export function getHostedRoom(code: string, hostToken: string): Promise<HostedRoomSummary> {
  return request(`/api/rooms/${encodeURIComponent(code)}/host-session`, hostAuthorization(hostToken))
}

export function endHostedRoom(code: string, hostToken: string): Promise<void> {
  return request(`/api/rooms/${encodeURIComponent(code)}/end`, {
    method: 'POST',
    ...hostAuthorization(hostToken),
  })
}

// ---- History ---------------------------------------------------------

export interface ServerHistorySummary {
  id: string
  code: string
  packTitle: string
  status: string
  createdAt: string
  completedAt: string | null
  playerCount: number
}

export interface ServerHistoryPlayer {
  id: string
  nickname: string
  teamName: string | null
  score: number
}

export interface ServerHistoryDetail {
  room: {
    id: string
    code: string
    packTitle: string
    status: string
    settings: string
    createdAt: string
    completedAt: string | null
  }
  players: ServerHistoryPlayer[]
  submissions: unknown[]
}

export function listHistory(): Promise<ServerHistorySummary[]> {
  return request('/api/history')
}

export function deleteHistoryGame(id: string): Promise<void> {
  return request(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function clearHistory(): Promise<{ deletedCount: number }> {
  return request('/api/history', { method: 'DELETE' })
}

export function getHistoryDetail(id: string): Promise<ServerHistoryDetail> {
  return request(`/api/history/${encodeURIComponent(id)}`)
}

export function historyExportCsvUrl(id: string): string {
  return `/api/history/${encodeURIComponent(id)}/export.csv`
}

// ---- Health --------------------------------------------------------------

export function getHealth(): Promise<{ name: string; status: string; timestamp: string; joinUrl: string }> {
  return request('/api/health')
}
