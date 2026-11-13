import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_LOCKED } from './adminAuth'
import { createRoom, getHostedRoom, listPacks } from './apiClient'

afterEach(() => { vi.unstubAllGlobals() })

describe('admin access failures', () => {
  it('signals reauthentication without replaying a rejected mutation', async () => {
    const target = new EventTarget()
    const locked = vi.fn()
    target.addEventListener(ADMIN_LOCKED, locked)
    vi.stubGlobal('window', target)
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Unlock host tools to continue', code: 'admin_auth_required',
    }), { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createRoom('pack')).rejects.toMatchObject({ status: 401, code: 'admin_auth_required' })
    expect(locked).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('/api/rooms', expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('does not treat a room-token rejection or a network outage as an expired admin unlock', async () => {
    const target = new EventTarget()
    const locked = vi.fn()
    target.addEventListener(ADMIN_LOCKED, locked)
    vi.stubGlobal('window', target)
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Host authorization failed' }), { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(getHostedRoom('ROOM', 'dummy-token')).rejects.toMatchObject({ status: 401, code: undefined })
    fetch.mockRejectedValue(new Error('offline'))
    await expect(listPacks()).rejects.toMatchObject({ status: 0 })
    expect(locked).not.toHaveBeenCalled()
  })
})
