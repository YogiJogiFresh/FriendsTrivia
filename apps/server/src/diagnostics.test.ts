import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { diagnose, diagnosticMedia, diagnosticStage, diagnosticTime, diagnosticTransfer } from './diagnostics.js'

afterEach(() => vi.unstubAllEnvs())

it('is off by default and cannot change an operation result', async () => {
  vi.stubEnv('FRIENDS_TRIVIA_DIAGNOSTICS', '')
  const log = vi.fn()
  expect(await diagnose('socket', log, async () => 42)).toBe(42)
  expect(log).not.toHaveBeenCalled()
  vi.stubEnv('FRIENDS_TRIVIA_DIAGNOSTICS', '1')
  expect(await diagnose('socket', () => { throw new Error('Logger failed') }, async () => 42)).toBe(42)
})

it('isolates concurrent traces, bounds stages and never captures operation data or errors', async () => {
  vi.stubEnv('FRIENDS_TRIVIA_DIAGNOSTICS', '1')
  const log = vi.fn()
  await Promise.all([
    diagnose('socket', log, async () => {
      for (let i = 0; i < 150; i++) diagnosticStage('queue', i)
      return { hostToken: 'private-token', answer: 'hidden-answer' }
    }, 'request_123'),
    diagnose('media', log, () => diagnosticTime('storage', async () => {
      diagnosticMedia('asset_123')
      diagnosticMedia('secret-uri?token=private')
      throw new Error('secret-uri')
    })).catch(() => {}),
  ])
  expect(log.mock.calls[0]![0].stages).toHaveLength(100)
  expect(log.mock.calls[1]![0].stages).toHaveLength(1)
  expect(log.mock.calls[1]![0].succeeded).toBe(false)
  expect(log.mock.calls[1]![0].mediaId).toBe('asset_123')
  expect(log.mock.calls[0]![0].mediaId).toBeUndefined()
  const output = JSON.stringify(log.mock.calls)
  for (const secret of ['private-token', 'hidden-answer', 'secret-uri', 'hostToken']) expect(output).not.toContain(secret)
})

it('correlates completed and aborted transfers after the handler returns and removes listeners', async () => {
  vi.stubEnv('FRIENDS_TRIVIA_DIAGNOSTICS', '1')
  for (const [event, outcome] of [['finish', 'completed'], ['close', 'aborted']] as const) {
    const response = new EventEmitter()
    const log = vi.fn()
    await diagnose('media', () => {}, async () => {
      diagnosticTransfer(response as ServerResponse, log)
      diagnosticMedia('asset_123')
    })
    response.emit(event)
    response.emit('close')
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toMatchObject({ mediaId: 'asset_123', operation: 'media_transfer', outcome })
    expect(response.listenerCount('close') + response.listenerCount('finish')).toBe(0)
  }
})
