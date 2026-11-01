import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { allowedRequestOrigin, CLOUD_PROXY_RANGES, registerPublicAccess } from './publicAccess.js'

describe('public application access', () => {
  it('permits anonymous same-origin mutations and rejects third-party browser mutations', async () => {
    const app = Fastify()
    registerPublicAccess(app, 'https://trivia.example')
    app.post('/library', async () => ({ changed: true }))
    app.get('/library', async () => ({ public: true }))
    try {
      expect((await app.inject({ method: 'POST', url: '/library' })).statusCode).toBe(200)
      expect((await app.inject({
        method: 'POST', url: '/library', headers: { origin: 'https://trivia.example' },
      })).statusCode).toBe(200)
      expect((await app.inject({
        method: 'POST', url: '/library', headers: { origin: 'https://unrelated.example' },
      })).statusCode).toBe(403)
      expect((await app.inject({
        method: 'GET', url: '/library', headers: { origin: 'https://unrelated.example' },
      })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('uses actual local origins but never lets Host override the configured public origin', () => {
    expect(allowedRequestOrigin({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })).toBe(true)
    expect(allowedRequestOrigin({ host: '[::1]:3000', origin: 'http://[::1]:3000' })).toBe(true)
    expect(allowedRequestOrigin({ host: '192.168.1.2:3000', origin: 'http://192.168.1.2:3000' })).toBe(true)
    expect(allowedRequestOrigin({
      host: 'unrelated.example', origin: 'https://unrelated.example',
    }, 'https://trivia.example')).toBe(false)
    for (const origin of ['null', '', 'https://trivia.example/path', 'https://user@trivia.example']) {
      expect(allowedRequestOrigin({ origin }, 'https://trivia.example')).toBe(false)
    }
  })

  it('keeps local browser hosting usable when PUBLIC_URL overrides advertised QR links', async () => {
    const app = Fastify()
    registerPublicAccess(app, 'https://qr.example', 'local')
    app.post('/library', async () => ({ changed: true }))
    try {
      expect((await app.inject({
        method: 'POST', url: '/library', headers: { origin: 'http://localhost' },
      })).statusCode).toBe(200)
      expect((await app.inject({
        method: 'POST', url: '/library', headers: { origin: 'https://qr.example' },
      })).statusCode).toBe(200)
      expect((await app.inject({
        method: 'POST', url: '/library', headers: { origin: 'https://unrelated.example' },
      })).statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('trusts forwarded client IPs only behind configured internal cloud proxies', async () => {
    const cloud = Fastify({ trustProxy: CLOUD_PROXY_RANGES })
    const local = Fastify({ trustProxy: false })
    cloud.get('/ip', async (request) => ({ ip: request.ip }))
    local.get('/ip', async (request) => ({ ip: request.ip }))
    const request = {
      url: '/ip',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' },
    }
    try {
      expect((await cloud.inject(request)).json()).toEqual({ ip: '203.0.113.7' })
      expect((await local.inject(request)).json()).toEqual({ ip: '10.0.0.1' })
      expect((await cloud.inject({ ...request, remoteAddress: '203.0.113.20' })).json())
        .toEqual({ ip: '203.0.113.20' })
    } finally {
      await cloud.close()
      await local.close()
    }
  })
})
