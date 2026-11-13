import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminCredentials, ADMIN_SESSION_SECONDS, registerAdminAuth } from './adminAuth.js'
import { openDatabase } from './database.js'
import { PackRepository } from './repositories/packs.js'
import { registerPackRoutes } from './routes/packs.js'

const origin = 'https://trivia.example'
const password = 'test-only admin passphrase'
const environment = { FRIENDS_TRIVIA_ADMIN_PASSWORD: password, FRIENDS_TRIVIA_ADMIN_SESSION_KEY: '12'.repeat(32) }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0)) await close()
})

async function fixture(local = false, values = environment) {
  const app = Fastify()
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
  const auth = await registerAdminAuth(app, adminCredentials(local ? 'local' : 'cloud', values), origin)
  const touched = vi.fn(() => ({ ok: true }))
  for (const url of ['/api/packs', '/api/packs/:id', '/api/packs/:id/export-bundle', '/api/rooms/:code/host-session']) {
    app.get(url, touched)
  }
  for (const url of ['/api/packs', '/api/packs/import-bundle', '/api/rooms', '/api/rooms/:code/end']) {
    app.post(url, touched)
  }
  app.put('/api/packs/:id', touched)
  app.delete('/api/packs/:id', touched)
  for (const url of ['/api/health', '/api/rooms/:code', '/api/media', '/api/gifs/providers', '/api/history']) {
    app.get(url, async () => ({ public: true }))
  }
  cleanup.push(() => app.close())
  async function unlock() {
    const response = await app.inject({
      method: 'POST', url: '/api/admin/unlock', headers: { origin }, payload: { password: values.FRIENDS_TRIVIA_ADMIN_PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    return String(response.headers['set-cookie']).split(';')[0]!
  }
  return { app, auth, touched, unlock }
}

describe('cloud admin gate', () => {
  it('fails closed without resolved credentials, and does not require credentials locally', () => {
    expect(adminCredentials('local', {})).toBeUndefined()
    expect(() => adminCredentials('cloud', {})).toThrow('FRIENDS_TRIVIA_ADMIN_PASSWORD')
    for (const value of ['', 'x'.repeat(1025), '\u00e9'.repeat(513)]) {
      expect(() => adminCredentials('cloud', { ...environment, FRIENDS_TRIVIA_ADMIN_PASSWORD: value }))
        .toThrow('FRIENDS_TRIVIA_ADMIN_PASSWORD')
    }
    expect(() => adminCredentials('cloud', { ...environment, FRIENDS_TRIVIA_ADMIN_PASSWORD: '@Microsoft.KeyVault(SecretUri=unresolved)' }))
      .toThrow('FRIENDS_TRIVIA_ADMIN_PASSWORD')
    expect(() => adminCredentials('cloud', { ...environment, FRIENDS_TRIVIA_ADMIN_SESSION_KEY: '@Microsoft.KeyVault(unresolved)' }))
      .toThrow('FRIENDS_TRIVIA_ADMIN_SESSION_KEY')
  })

  it.each(['x', 'short-test'])('unlocks using a short plaintext password (%s)', async (value) => {
    const { app, unlock } = await fixture(false, { ...environment, FRIENDS_TRIVIA_ADMIN_PASSWORD: value })
    const incorrect = await app.inject({
      method: 'POST', url: '/api/admin/unlock', headers: { origin }, payload: { password: `${value}-wrong` },
    })
    expect(incorrect.statusCode).toBe(401)
    const cookie = await unlock()
    expect((await app.inject({ url: '/api/packs', headers: { cookie } })).statusCode).toBe(200)
  })

  it('gates reads, HEAD, exports, imports and mutations before handlers or JSON parsing', async () => {
    const { app, touched, unlock } = await fixture()
    const routes = [
      ['GET', '/api/packs?includeArchived=true'], ['HEAD', '/api/packs/test'], ['GET', '/api/packs/test'],
      ['GET', '/api/packs/test/export-bundle'], ['POST', '/api/packs/import-bundle'],
      ['POST', '/api/packs'], ['PUT', '/api/packs/test'], ['DELETE', '/api/packs/test'],
      ['POST', '/api/rooms'], ['GET', '/api/rooms/ROOM/host-session'], ['POST', '/api/rooms/ROOM/end'],
    ] as const
    for (const [method, url] of routes) {
      const response = await app.inject({ method, url, headers: { origin } })
      expect(response.statusCode, `${method} ${url}`).toBe(401)
      expect(response.headers['cache-control']).toBe('no-store')
    }
    expect((await app.inject({
      method: 'POST', url: '/api/packs/import-bundle',
      headers: { origin, 'content-type': 'application/json' }, payload: '{',
    })).statusCode).toBe(401)
    expect(touched).not.toHaveBeenCalled()
    const cookie = await unlock()
    for (const [method, url] of routes) {
      expect((await app.inject({ method, url, headers: { origin, cookie } })).statusCode, `${method} ${url}`).toBe(200)
    }
  })

  it('does not prepare or delete a real saved pack without an admin cookie', async () => {
    const app = Fastify()
    const database = openDatabase(':memory:')
    cleanup.push(async () => { await app.close(); database.close() })
    await registerAdminAuth(app, adminCredentials('cloud', environment), origin)
    const packs = new PackRepository(database)
    const pack = await packs.create({ title: 'Private pack' })
    const prepare = vi.fn()
    await registerPackRoutes(app, packs, prepare)
    const response = await app.inject({ method: 'DELETE', url: `/api/packs/${pack.id}`, headers: { origin } })
    expect(response.statusCode).toBe(401)
    expect(prepare).not.toHaveBeenCalled()
    expect(await packs.get(pack.id)).toMatchObject({ title: 'Private pack' })
  })

  it('rechecks expiry after body processing before invoking a protected handler', async () => {
    const { app, auth, touched, unlock } = await fixture()
    let expiresAt: number | undefined
    app.addHook('preParsing', async (_request, _reply, payload) => {
      if (expiresAt !== undefined) vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
      return payload
    })
    const cookie = await unlock()
    expiresAt = auth.read({ cookie })!.expiresAt
    const response = await app.inject({
      method: 'POST', url: '/api/packs', headers: { origin, cookie }, payload: { title: 'Too late' },
    })
    expect(response.statusCode).toBe(401)
    expect(touched).not.toHaveBeenCalled()
  })

  it('rejects absent/cross origins, limits wrong passwords, and keeps errors generic', async () => {
    const { app, unlock } = await fixture()
    for (const headers of [{}, { origin: 'https://other.example' }, { origin: 'null' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/admin/unlock', headers, payload: { password } })).statusCode).toBe(403)
    }
    const cookie = await unlock()
    for (const url of ['/api/packs', '/api/admin/lock']) {
      expect((await app.inject({ method: 'POST', url, headers: { cookie } })).statusCode).toBe(403)
    }
    const limited = await fixture()
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await limited.app.inject({
        method: 'POST', url: '/api/admin/unlock', headers: { origin }, payload: { password: 'wrong' },
      })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'Unable to unlock host tools' })
    }
    expect((await limited.app.inject({
      method: 'POST', url: '/api/admin/unlock', headers: { origin }, payload: { password },
    })).statusCode).toBe(429)
  })

  it('uses a secure fixed-life cookie, rejects tampering/expiry and clears it on logout', async () => {
    const { app, auth, unlock } = await fixture()
    const cookie = await unlock()
    const grant = auth.read({ cookie })!
    const status = await app.inject({ url: '/api/admin/session', headers: { cookie } })
    expect(status.json()).toEqual({ enabled: true, unlocked: true, expiresAt: grant.expiresAt })
    expect(status.headers['set-cookie']).toBeUndefined()
    expect(status.headers['cache-control']).toBe('no-store')
    const response = await app.inject({
      method: 'POST', url: '/api/admin/unlock', headers: { origin }, payload: { password },
    })
    expect(response.headers['set-cookie']).toMatch(/__Host-friends-trivia-admin=/)
    expect(response.headers['set-cookie']).toMatch(/HttpOnly/)
    expect(response.headers['set-cookie']).toMatch(/Secure/)
    expect(response.headers['set-cookie']).toMatch(/SameSite=Strict/)
    expect(response.headers['set-cookie']).toMatch(/Path=\//)
    expect(response.headers['set-cookie']).toMatch(new RegExp(`Max-Age=${ADMIN_SESSION_SECONDS}`))
    expect(auth.read({ cookie: '__Host-friends-trivia-admin=tampered' })).toBeNull()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
    expect((await app.inject({ url: '/api/packs', headers: { cookie } })).statusCode).toBe(401)
    clock.mockRestore()
    const logout = vi.fn()
    auth.onLogout(logout)
    const locked = await app.inject({ method: 'POST', url: '/api/admin/lock', headers: { origin, cookie } })
    expect(locked.statusCode).toBe(204)
    expect(locked.headers['set-cookie']).toMatch(/Max-Age=0/)
    expect(logout).toHaveBeenCalledWith(grant.id)
    expect((await app.inject({ url: '/api/packs' })).statusCode).toBe(401)
  })

  it('invalidates cookies after password or session-key rotation, but preserves ordinary restarts', async () => {
    const first = await fixture()
    const cookie = await first.unlock()
    const restarted = await fixture()
    expect(restarted.auth.read({ cookie })).not.toBeNull()
    for (const changed of [
      { ...environment, FRIENDS_TRIVIA_ADMIN_PASSWORD: 'another test-only passphrase' },
      { ...environment, FRIENDS_TRIVIA_ADMIN_SESSION_KEY: '34'.repeat(32) },
    ]) {
      const next = await fixture(false, changed)
      expect((await next.app.inject({ url: '/api/packs', headers: { cookie } })).statusCode).toBe(401)
    }
  })

  it('keeps public reads and all local host routes password-free', async () => {
    const { app } = await fixture()
    for (const url of ['/api/health', '/api/rooms/ROOM', '/api/media', '/api/gifs/providers', '/api/history']) {
      expect((await app.inject({ url })).statusCode).toBe(200)
    }
    const local = await fixture(true)
    expect((await local.app.inject({ url: '/api/admin/session' })).json())
      .toEqual({ enabled: false, unlocked: true, expiresAt: null })
    expect((await local.app.inject({ method: 'POST', url: '/api/rooms' })).statusCode).toBe(200)
    expect((await local.app.inject({ method: 'DELETE', url: '/api/packs/test' })).statusCode).toBe(200)
  })
})
