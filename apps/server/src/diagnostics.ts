import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'

interface Trace {
  id: string
  operation: string
  requestId?: string
  stages: Array<{ stage: string; ms: number; value?: number }>
  phase?: string
  stateVersion?: number
  clueId?: string | undefined
  roomGeneration?: string
  mediaId?: string
}
const traces = new AsyncLocalStorage<Trace>()

export function diagnosticMedia(id: string): void {
  const trace = traces.getStore()
  if (trace && /^[A-Za-z0-9_-]{1,100}$/.test(id)) trace.mediaId = id
}

export function diagnosticStage(stage: string, ms: number, value?: number): void {
  const trace = traces.getStore()
  if (trace && trace.stages.length < 100) {
    trace.stages.push({ stage, ms: Math.round(ms * 100) / 100, ...(value === undefined ? {} : { value }) })
  }
}

export function diagnosticRoom(room: {
  ref: { generation: string }; stateVersion: number; state: { phase: string; activeClueId?: string | undefined; startedAt?: string | undefined }
}): void {
  const trace = traces.getStore()
  if (!trace) return
  trace.phase = room.state.phase
  trace.stateVersion = room.stateVersion
  trace.clueId = room.state.activeClueId
  trace.roomGeneration = room.ref.generation
  if (room.state.startedAt && ['ACCEPTING_ANSWERS', 'FINAL_QUESTION'].includes(room.state.phase)) {
    diagnosticStage('answer_age_at_observation', Date.now() - Date.parse(room.state.startedAt))
  }
}

export async function diagnosticTime<T>(stage: string, action: () => Promise<T>): Promise<T> {
  if (!traces.getStore()) return action()
  const start = performance.now()
  try { return await action() } finally { diagnosticStage(stage, performance.now() - start) }
}

export function diagnosticTransfer(response: ServerResponse, log: (event: object) => void): void {
  const trace = traces.getStore()
  if (!trace) return
  const start = performance.now()
  let finished = false
  function complete(outcome: 'completed' | 'aborted') {
    if (finished) return
    finished = true
    response.off('finish', onFinish)
    response.off('close', onClose)
    try { log({ id: trace!.id, mediaId: trace!.mediaId, operation: 'media_transfer', outcome, ms: performance.now() - start }) } catch { /* Logging is best effort. */ }
  }
  const onFinish = () => complete('completed')
  const onClose = () => complete('aborted')
  response.once('finish', onFinish)
  response.once('close', onClose)
}

export async function diagnose<T>(operation: 'socket' | 'broadcast' | 'media',
  log: (trace: Trace & { ms: number; succeeded: boolean }) => void, action: () => Promise<T>, requestId?: string): Promise<T> {
  if (process.env.FRIENDS_TRIVIA_DIAGNOSTICS !== '1') return action()
  const trace: Trace = { id: randomUUID(), operation, stages: [] }
  if (requestId && /^[A-Za-z0-9_-]{8,100}$/.test(requestId)) trace.requestId = requestId
  const start = performance.now()
  let succeeded = false
  return traces.run(trace, async () => {
    try { const result = await action(); succeeded = true; return result } finally {
      try { log({ ...trace, stages: [...trace.stages], ms: performance.now() - start, succeeded }) } catch { /* Diagnostics cannot fail a command. */ }
    }
  })
}
