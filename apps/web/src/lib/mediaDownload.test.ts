import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadMedia } from './apiClient'
import type { ServerMediaAsset } from './apiClient'
import { MAX_SOURCE_BYTES } from './audioSnippets'

afterEach(() => vi.unstubAllGlobals())

const asset = { id: 'song', originalName: 'Song.wav', mimeType: 'audio/wav' } as ServerMediaAsset

describe('bounded library song downloads', () => {
  it('keeps the name, type and original bytes when downloading for adjustment', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    const file = await downloadMedia(asset, signal)
    expect(file.name).toBe('Song.wav')
    expect(file.type).toBe('audio/wav')
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3])
    expect(fetch).toHaveBeenCalledWith('/api/media/song/stream', { signal, credentials: 'same-origin' })
  })

  it('rejects missing media and oversized advertised content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Media missing"}', { status: 404 })))
    await expect(downloadMedia(asset, new AbortController().signal)).rejects.toThrow('Media missing')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bytes', { headers: { 'Content-Length': String(MAX_SOURCE_BYTES + 1) } })))
    await expect(downloadMedia(asset, new AbortController().signal)).rejects.toThrow('50 MB')
  })

  it('enforces the actual streamed limit without trusting a missing content length', async () => {
    const cancel = vi.fn(async () => {})
    const releaseLock = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, headers: new Headers(),
      body: { getReader: () => ({ read: async () => ({ value: { byteLength: MAX_SOURCE_BYTES + 1 } }), cancel, releaseLock }) },
    })))
    await expect(downloadMedia(asset, new AbortController().signal)).rejects.toThrow('50 MB')
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).toHaveBeenCalledOnce()
  })

  it('releases the stream after interrupted reads', async () => {
    const cancel = vi.fn(async () => {})
    const releaseLock = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, headers: new Headers(),
      body: { getReader: () => ({ read: async () => { throw new DOMException('Canceled', 'AbortError') }, cancel, releaseLock }) },
    })))
    await expect(downloadMedia(asset, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).toHaveBeenCalledOnce()
  })
})
