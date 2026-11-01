import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyInstance } from 'fastify'

export const CLOUD_PROXY_RANGES = ['loopback', 'linklocal', 'uniquelocal']

export function allowedRequestOrigin(
  headers: IncomingHttpHeaders,
  publicUrl?: string,
  protocol = 'http',
): boolean {
  if (headers.origin === undefined) return true
  if (!publicUrl && !headers.host) return false
  try {
    const origin = new URL(headers.origin)
    const expected = new URL(publicUrl ?? `${protocol}://${headers.host}`)
    return headers.origin === origin.origin && origin.origin === expected.origin
  } catch {
    return false
  }
}

export function registerPublicAccess(app: FastifyInstance, publicUrl?: string, mode: 'local' | 'cloud' = 'cloud'): void {
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    const allowed = allowedRequestOrigin(request.headers, publicUrl, request.protocol) ||
      (mode === 'local' && allowedRequestOrigin(request.headers, undefined, request.protocol))
    if (!allowed) {
      request.log.warn({ method: request.method }, 'Cross-origin mutation rejected')
      return reply.code(403).send({ error: 'Cross-origin mutations are not allowed' })
    }
  })
}
