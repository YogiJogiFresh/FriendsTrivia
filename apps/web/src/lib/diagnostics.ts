interface Fields {
  requestId?: string
  command?: string
  phase?: string
  roomGeneration?: string
  stateVersion?: number
  snapshotSequence?: number
  clueId?: string
  mediaId?: string
  actualMediaId?: string
  readyState?: number
  networkState?: number
  position?: number
  duration?: number
  buffered?: number
  delaySeconds?: number
  playCount?: number
  plays?: number
  error?: string
  ms?: number
  remainingSeconds?: number
  headerMs?: number
  transferBytes?: number
  decodedBytes?: number
}
const allowed = new Set([
  'requestId', 'command', 'phase', 'roomGeneration', 'stateVersion', 'snapshotSequence', 'clueId',
  'mediaId', 'actualMediaId', 'readyState', 'networkState', 'position', 'duration', 'buffered',
  'delaySeconds', 'playCount', 'plays', 'error', 'ms', 'remainingSeconds', 'headerMs', 'transferBytes', 'decodedBytes',
])
const records: Array<{ event: string; at: number; fields: Fields }> = []
declare global {
  interface Window {
    friendsTriviaDiagnostics?: {
      read: () => typeof records
      clear: () => void
    }
  }
}

export function diagnosticsEnabled(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('diagnostics') === '1'
}

export function traceEvent(event: string, fields: Fields = {}): void {
  if (!diagnosticsEnabled()) return
  const safe = Object.fromEntries(Object.entries(fields).filter(([key, value]) => allowed.has(key) &&
    (typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && value.length <= 100)))
  records.push({ event, at: performance.now(), fields: safe })
  if (records.length > 500) records.shift()
  window.friendsTriviaDiagnostics ??= {
    read: () => records.map(record => ({ ...record, fields: { ...record.fields } })),
    clear: () => { records.length = 0 },
  }
}

export function mediaIdentity(url: string): string {
  try { return new URL(url, window.location.origin).pathname.match(/^\/api\/media\/([^/]+)\/stream$/)?.[1] ?? 'other' } catch { return 'none' }
}
