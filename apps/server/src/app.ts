import fs from 'node:fs'
import path from 'node:path'

import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import staticPlugin from '@fastify/static'
import Fastify from 'fastify'

import { config } from './config.js'
import { audioTypeForFile, ensureContentDirectories, resolveContentPath } from './content.js'
import { openDatabase } from './database.js'
import { GameEngine } from './game/engine.js'
import { preferredJoinBaseUrl } from './network.js'
import { MediaRepository } from './repositories/media.js'
import { PackRepository } from './repositories/packs.js'
import { RoomRepository } from './repositories/rooms.js'
import { registerHistoryRoutes } from './routes/history.js'
import { registerGifRoutes } from './routes/gifs.js'
import { registerMediaRoutes } from './routes/media.js'
import { registerPackBundleRoutes } from './routes/packBundles.js'
import { registerPackRoutes } from './routes/packs.js'
import { registerRoomRoutes } from './routes/rooms.js'
import { registerSocketServer } from './socket.js'

export async function buildApp() {
  ensureContentDirectories(config.contentRoot)
  const database = openDatabase(config.databasePath)
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 })

  app.addHook('onClose', async () => database.close())
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          'data:',
          'https://*.giphy.com',
          'https://media.tenor.com',
          'https:',
        ],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
  })
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
  await app.register(multipart)

  const packs = new PackRepository(database)
  const media = new MediaRepository(database)
  const songsDirectory = resolveContentPath(config.contentRoot, 'songs')
  for (const entry of await fs.promises.readdir(songsDirectory, { withFileTypes: true })) {
    const mimeType = entry.isFile() ? audioTypeForFile(entry.name) : undefined
    if (!mimeType) continue
    const relativePath = path.join('songs', entry.name)
    const stats = await fs.promises.stat(resolveContentPath(config.contentRoot, relativePath))
    media.createIfMissing({
      relativePath,
      originalName: entry.name,
      mimeType,
      sizeBytes: stats.size,
    })
  }
  const rooms = new RoomRepository(database)
  const joinBaseUrl = preferredJoinBaseUrl(config.publicUrl, config.port)
  const engine = new GameEngine(database, rooms, joinBaseUrl)
  engine.recoverInterruptedGames()
  await registerPackRoutes(app, packs, (packId) => engine.preparePackDeletion(packId))
  await registerPackBundleRoutes(app, packs, media, config.contentRoot)
  await registerGifRoutes(app, database, {
    giphy: config.giphyApiKey,
    tenor: config.tenorApiKey,
  })
  await registerMediaRoutes(app, media, config.contentRoot)
  await registerRoomRoutes(
    app,
    rooms,
    engine,
    config.roomCodeLength,
    () => joinBaseUrl,
  )
  await registerHistoryRoutes(app, database)
  registerSocketServer(app, rooms, engine)

  app.get('/api/health', async () => ({
    name: 'FriendsTrivia',
    status: 'ok',
    timestamp: new Date().toISOString(),
    joinUrl: preferredJoinBaseUrl(config.publicUrl, config.port),
  }))

  const webDist = config.webDist
  if (fs.existsSync(webDist)) {
    await app.register(staticPlugin, {
      root: webDist,
      wildcard: false,
    })
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/socket.io/')) {
      return reply.code(404).send({ error: 'Not found' })
    }
    if (fs.existsSync(webDist)) return reply.sendFile('index.html')
    return reply.code(404).send({ error: 'Web application is served by Vite in development' })
  })

  return { app, database }
}
