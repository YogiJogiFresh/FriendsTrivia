import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'linux')
assert.equal(process.versions.node.split('.')[0], '22')
const artifact = process.cwd()
const require = createRequire(path.join(artifact, 'package.json'))
const load = (relative) => import(pathToFileURL(path.join(artifact, relative)).href)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'friends-trivia-linux-smoke-'))
Object.assign(process.env, {
  FRIENDS_TRIVIA_MODE: 'local',
  APP_ROOT: artifact,
  DATABASE_PATH: path.join(root, 'game.db'),
  CONTENT_ROOT: path.join(root, 'content'),
  WEB_DIST: path.join(artifact, 'apps', 'web', 'dist'),
  PORT: '0',
  HOST: '127.0.0.1',
})
for (const key of ['PUBLIC_URL', 'WEBSITE_SITE_NAME', 'WEBSITE_INSTANCE_ID']) delete process.env[key]
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@azure/')) throw new Error(`Offline startup imported Azure SDK: ${specifier}`)
    return next(specifier, context)
  },
})
let app
let socket
try {
  const { buildApp } = await load('apps/server/dist/app.js')
  const result = await buildApp()
  app = result.app
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  const health = await fetch(`${origin}/api/health`)
  assert.equal(health.status, 200)
  const healthBody = await health.json()
  assert.equal(healthBody.status, 'ok')
  assert.match(healthBody.bootId, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.equal(health.headers.get('cache-control'), 'no-store')
  assert.equal((await (await fetch(`${origin}/api/health`)).json()).bootId, healthBody.bootId)
  for (const route of ['/', '/host', '/history']) {
    const response = await fetch(`${origin}${route}`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<div id="root"/)
  }
  socket = require('socket.io-client').io(origin, {
    transports: ['websocket'], reconnection: false, timeout: 5000, extraHeaders: { Origin: origin },
  })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  const { PackRepository } = await load('apps/server/dist/repositories/packs.js')
  const { MediaRepository } = await load('apps/server/dist/repositories/media.js')
  const { FilesystemMediaStorage } = await load('apps/server/dist/storage/media.js')
  const { createPackBundle, importPackBundle } = await load('apps/server/dist/routes/packBundles.js')
  const packs = new PackRepository(result.database)
  const media = new MediaRepository(result.database)
  const storage = new FilesystemMediaStorage(process.env.CONTENT_ROOT)
  const bytes = Buffer.from('Generated Linux artifact media fixture')
  await storage.write('songs/fixture.mp3', Readable.from(bytes), 'audio/mpeg')
  const song = await media.create({
    relativePath: 'songs/fixture.mp3', originalName: 'fixture.mp3', mimeType: 'audio/mpeg', sizeBytes: bytes.length,
  })
  const pack = await packs.create({ title: 'Linux artifact smoke' })
  await packs.replace(pack.id, {
    title: 'Linux artifact smoke', status: 'ready',
    categories: [{ title: 'Fixture', clues: [{
      type: 'music_free_text', boardValue: 100, prompt: 'Fixture question',
      mediaAssetId: song.id, config: { correctAnswer: 'Fixture answer' },
    }] }],
  })
  const bundle = await createPackBundle(await packs.get(pack.id), media, process.env.CONTENT_ROOT, { storage })
  assert.ok(require('fflate').unzipSync(bundle)['pack.json'])
  const imported = await importPackBundle(bundle, packs, media, process.env.CONTENT_ROOT, storage)
  assert.equal(imported.title, 'Linux artifact smoke')
  assert.ok(imported.categories[0].clues[0].mediaAssetId)
  const rejectedDatabase = path.join(root, 'must-not-create.db')
  const child = spawnSync(process.execPath, [path.join(artifact, 'apps', 'server', 'dist', 'index.js')], {
    cwd: artifact, timeout: 10_000, encoding: 'utf8',
    env: { ...process.env, WEBSITE_SITE_NAME: 'smoke-appservice', DATABASE_PATH: rejectedDatabase },
  })
  assert.equal(child.status, 1)
  assert.match(child.stderr, /App Service requires FRIENDS_TRIVIA_MODE=cloud/)
  assert.equal(fs.existsSync(rejectedDatabase), false)
  console.log('Linux artifact smoke passed: native SQLite, offline HTTP/deep links, WebSocket, ZIP workers and App Service mode guard.')
} finally {
  socket?.disconnect()
  await app?.close()
  hooks.deregister()
  fs.rmSync(root, { recursive: true, force: true })
}
