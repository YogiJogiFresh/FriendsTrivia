import { once } from 'node:events'
import { createServer as createBackend, type IncomingHttpHeaders } from 'node:http'
import net from 'node:net'
import { createServer, type ViteDevServer } from 'vite'
import { expect, it } from 'vitest'

import config from '../../vite.config'

it('preserves browser Host and Origin through the HTTP and WebSocket development proxies', async () => {
  const backend = createBackend((request, reply) => {
    reply.setHeader('Content-Type', 'application/json')
    reply.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin }))
  })
  await new Promise<void>((resolve, reject) => {
    backend.once('error', reject)
    backend.listen(0, '127.0.0.1', resolve)
  })
  let dev: ViteDevServer | undefined
  let connection: net.Socket | undefined
  try {
    const address = backend.address()
    if (!address || typeof address === 'string') throw new Error('Missing backend port')
    const proxy = { ...config.server?.proxy }
    for (const route of ['/api', '/socket.io']) {
      const options = proxy[route]
      if (!options || typeof options === 'string') throw new Error('Missing development proxy')
      proxy[route] = { ...options, target: `http://127.0.0.1:${address.port}` }
    }
    dev = await createServer({
      ...config,
      configFile: false,
      logLevel: 'silent',
      server: { ...config.server, host: '127.0.0.1', port: 0, proxy },
    })
    await dev.listen()
    const frontend = dev.httpServer?.address()
    if (!frontend || typeof frontend === 'string') throw new Error('Missing frontend port')
    const origin = `http://127.0.0.1:${frontend.port}`
    const host = new URL(origin).host
    const response = await fetch(`${origin}/api/test`, {
      method: 'POST', headers: { Origin: origin },
    })
    expect(await response.json()).toEqual({ host, origin })
    const upgraded = new Promise<IncomingHttpHeaders>((resolve) => {
      backend.once('upgrade', (request, socket) => {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
        resolve(request.headers)
      })
    })
    connection = net.createConnection({ host: '127.0.0.1', port: frontend.port })
    await once(connection, 'connect')
    connection.write(
      `GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\n` +
      'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    )
    expect(await upgraded).toMatchObject({ host, origin })
  } finally {
    connection?.destroy()
    await dev?.close()
    await new Promise<void>((resolve, reject) => {
      backend.close((error) => error ? reject(error) : resolve())
    })
  }
})
