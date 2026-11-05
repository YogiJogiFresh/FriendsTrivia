import { afterEach, expect, it, vi } from 'vitest'
import { mediaIdentity, traceEvent } from './diagnostics'

afterEach(() => vi.unstubAllGlobals())

it('keeps bounded local copies and excludes URLs, tokens and arbitrary fields', () => {
  const browser = { location: { search: '', origin: 'https://trivia.example' }, friendsTriviaDiagnostics: undefined } as unknown as Window
  vi.stubGlobal('window', browser)
  traceEvent('disabled')
  expect(browser.friendsTriviaDiagnostics).toBeUndefined()
  browser.location.search = '?diagnostics=1'
  for (let i = 0; i < 600; i++) traceEvent('audio', { position: i, token: 'secret', url: 'private-url' } as never)
  const records = browser.friendsTriviaDiagnostics!.read()
  expect(records).toHaveLength(500)
  expect(records[0]!.fields).toEqual({ position: 100 })
  expect(JSON.stringify(records)).not.toContain('secret')
  records[0]!.fields.position = -1
  expect(browser.friendsTriviaDiagnostics!.read()[0]!.fields.position).toBe(100)
  expect(mediaIdentity('/api/media/asset-id/stream?roomCode=PRIVATE')).toBe('asset-id')
  browser.friendsTriviaDiagnostics!.clear()
})
