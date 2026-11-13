import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { promisify } from 'node:util'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { DomainError } from './domain.js'
import { createToken } from './ids.js'

const derive = promisify(scrypt)
const cookieName = '__Host-friends-trivia-admin'
export const ADMIN_SESSION_SECONDS = 7 * 24 * 60 * 60

export interface AdminSession {
  id: string
  expiresAt: number
  credential: string
}
declare module '@fastify/secure-session' {
  interface SessionData {
    admin: AdminSession
  }
}
export interface AdminAuth {
  enabled: boolean
  read: (headers: IncomingHttpHeaders) => AdminSession | null
  valid: (session: AdminSession | null) => boolean
  require: (session: AdminSession | null) => void
  sameOrigin: (headers: IncomingHttpHeaders) => boolean
  onLogout: (listener: (id: string) => void) => () => void
}

export function adminCredentials(mode: 'local' | 'cloud', environment: NodeJS.ProcessEnv) {
  if (mode === 'local') return undefined
  const password = environment.FRIENDS_TRIVIA_ADMIN_PASSWORD
  const key = environment.FRIENDS_TRIVIA_ADMIN_SESSION_KEY
  if (!password || password.startsWith('@Microsoft.KeyVault(') ||
    Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 1024)
    throw new Error('FRIENDS_TRIVIA_ADMIN_PASSWORD must resolve to a passphrase of 16-1024 bytes')
  if (!key || !/^[a-fA-F0-9]{64}$/.test(key))
    throw new Error('FRIENDS_TRIVIA_ADMIN_SESSION_KEY must resolve to a 32-byte hexadecimal key')
  return { password, key: Buffer.from(key, 'hex') }
}

function protectedRoute(method: string, route: string): boolean {
  return route === '/api/packs' || route.startsWith('/api/packs/') ||
    (route === '/api/rooms' && method === 'POST') ||
    route === '/api/rooms/:code/host-session' || route === '/api/rooms/:code/end'
}

export async function registerAdminAuth(
  app: FastifyInstance,
  credentials: ReturnType<typeof adminCredentials>,
  publicUrl?: string,
): Promise<AdminAuth> {
  const enabled = credentials !== undefined
  if (enabled && !publicUrl) throw new Error('Admin authentication requires PUBLIC_URL')
  const origin = publicUrl ? new URL(publicUrl).origin : undefined
  const credential = credentials
    ? createHash('sha256').update(credentials.password).digest('hex') : ''
  const salt = randomBytes(16)
  const expected = credentials ? await derive(credentials.password, salt, 32) as Buffer : undefined
  const listeners = new Set<(id: string) => void>()

  if (credentials) {
    const { default: secureSession } = await import('@fastify/secure-session')
    await app.register(secureSession, {
      key: credentials.key,
      cookieName,
      expiry: ADMIN_SESSION_SECONDS,
      cookie: { path: '/', httpOnly: true, secure: true, sameSite: 'strict', maxAge: ADMIN_SESSION_SECONDS },
    })
  }

  const auth: AdminAuth = {
    enabled,
    sameOrigin: (headers) => !enabled || headers.origin === origin,
    valid: (session) => !enabled || Boolean(session &&
      typeof session.id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(session.id) &&
      session.credential === credential && Number.isSafeInteger(session.expiresAt) &&
      session.expiresAt > Date.now() && session.expiresAt <= Date.now() + ADMIN_SESSION_SECONDS * 1000),
    read: (headers) => {
      if (!enabled) return null
      try {
        const cookies = app.parseCookie(headers.cookie ?? '')
        const session = app.decodeSecureSession(cookies[cookieName] ?? '')
        const data = session?.get('admin') as AdminSession | undefined
        return data && auth.valid(data) ? data : null
      } catch {
        return null
      }
    },
    require: (session) => {
      if (!auth.valid(session)) throw new DomainError('admin_auth_required', 'Unlock host tools to continue')
    },
    onLogout: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  app.addHook('onClose', async () => { listeners.clear() })
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions.url ?? ''
    const privateRoute = enabled && protectedRoute(request.method, route)
    if (privateRoute || route.startsWith('/api/admin/')) reply.header('Cache-Control', 'no-store')
    if (!privateRoute) return
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !auth.sameOrigin(request.headers))
      return reply.code(403).send({ error: 'Use host tools from the application origin' })
    if (!auth.valid(auth.read(request.headers)))
      return reply.code(401).send({ error: 'Unlock host tools to continue', code: 'admin_auth_required' })
  }
  app.addHook('onRequest', authorize)
  app.addHook('preHandler', authorize)

  let attempts = 0
  let resetAt = 0
  let verifying = false
  app.get('/api/admin/session', async (request) => {
    const session = auth.read(request.headers)
    return { enabled, unlocked: auth.valid(session), expiresAt: session?.expiresAt ?? null }
  })
  app.post('/api/admin/unlock', {
    bodyLimit: 4096,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    onRequest: async (request, reply) => {
      if (!auth.sameOrigin(request.headers))
        return reply.code(403).send({ error: 'Use host tools from the application origin' })
      if (!enabled) return
      if (Date.now() >= resetAt) { attempts = 0; resetAt = Date.now() + 60_000 }
      if (++attempts > 20 || verifying)
        return reply.header('Retry-After', '60').code(429).send({ error: 'Too many unlock attempts. Try again shortly.' })
    },
  }, async (request, reply) => {
    if (!credentials) return { enabled: false, unlocked: true, expiresAt: null }
    const body = request.body as { password?: unknown } | undefined
    const password = body?.password
    if (typeof password !== 'string' || Buffer.byteLength(password) > 1024)
      return reply.code(401).send({ error: 'Unable to unlock host tools' })
    if (verifying)
      return reply.header('Retry-After', '60').code(429).send({ error: 'Too many unlock attempts. Try again shortly.' })
    verifying = true
    let matches: boolean
    try { matches = timingSafeEqual(await derive(password, salt, 32) as Buffer, expected!) }
    finally { verifying = false }
    if (!matches) return reply.code(401).send({ error: 'Unable to unlock host tools' })
    const session: AdminSession = {
      id: createToken(), expiresAt: Date.now() + ADMIN_SESSION_SECONDS * 1000, credential,
    }
    request.session.regenerate()
    request.session.set('admin', session)
    return { enabled: true, unlocked: true, expiresAt: session.expiresAt }
  })
  app.post('/api/admin/lock', {
    onRequest: async (request, reply) => {
      if (!auth.sameOrigin(request.headers))
        return reply.code(403).send({ error: 'Use host tools from the application origin' })
    },
  }, async (request, reply) => {
    const session = auth.read(request.headers)
    if (session) for (const listener of listeners) listener(session.id)
    if (enabled) request.session.delete()
    return reply.code(204).send()
  })
  return auth
}
