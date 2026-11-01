import fs from 'node:fs'
import path from 'node:path'

import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openDatabase } from '../database.js'
import { DomainError } from '../domain.js'
import { MediaRepository } from '../repositories/media.js'
import { PackRepository } from '../repositories/packs.js'
import { FilesystemMediaStorage, type MediaStorage } from '../storage/media.js'
import { registerMediaRoutes } from './media.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('media library', () => {
  it('reports the song directory and removes a song file and record', async () => {
    const contentRoot = await fs.promises.mkdtemp(path.join(process.cwd(), '.test-media-'))
    const songsDirectory = path.join(contentRoot, 'songs')
    await fs.promises.mkdir(songsDirectory)
    const songPath = path.join(songsDirectory, 'test.mp3')
    await fs.promises.writeFile(songPath, 'audio')

    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    const asset = await media.create({
      relativePath: path.join('songs', 'test.mp3'),
      originalName: 'test.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 5,
    })
    const app = Fastify()
    const packs = new PackRepository(database)
    const pack = await packs.create({ title: 'Local detach' }) as { id: string }
    await packs.replace(pack.id, {
      title: 'Local detach', categories: [{
        title: 'Music', clues: [{
          type: 'music_free_text', boardValue: 100, prompt: 'Name it',
          mediaAssetId: asset.id, revealMediaAssetId: asset.id, config: { correctAnswer: 'Answer' },
        }],
      }],
    })
    await registerMediaRoutes(app, media, contentRoot)
    cleanups.push(async () => {
      await app.close()
      database.close()
      await fs.promises.rm(contentRoot, { recursive: true, force: true })
    })

    const library = await app.inject({ method: 'GET', url: '/api/media/library' })
    expect(library.statusCode).toBe(200)
    expect(library.json()).toEqual({ directory: songsDirectory })

    const removed = await app.inject({ method: 'DELETE', url: `/api/media/${asset.id}` })
    expect(removed.statusCode).toBe(204)
    expect(await media.get(asset.id)).toBeUndefined()
    expect((await packs.get(pack.id))?.categories[0]?.clues[0]).toMatchObject({
      mediaAssetId: null, revealMediaAssetId: null,
    })
    await expect(fs.promises.stat(songPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('streams cacheable audio with byte range support', async () => {
    const contentRoot = await fs.promises.mkdtemp(path.join(process.cwd(), '.test-media-'))
    const songsDirectory = path.join(contentRoot, 'songs')
    await fs.promises.mkdir(songsDirectory)
    await fs.promises.writeFile(path.join(songsDirectory, 'test.mp3'), 'audio-data')

    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    const asset = await media.create({
      relativePath: path.join('songs', 'test.mp3'),
      originalName: 'test.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 10,
    })
    const app = Fastify()
    await registerMediaRoutes(app, media, contentRoot)
    cleanups.push(async () => {
      await app.close()
      database.close()
      await fs.promises.rm(contentRoot, { recursive: true, force: true })
    })

    const response = await app.inject({
      method: 'GET',
      url: `/api/media/${asset.id}/stream`,
      headers: { range: 'bytes=2-6' },
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers['accept-ranges']).toBe('bytes')
    expect(response.headers['cache-control']).toBe('private, max-age=3600')
    expect(response.headers['content-range']).toBe('bytes 2-6/10')
    expect(response.body).toBe('dio-d')
    expect(response.headers['content-length']).toBe('5')

    for (const [range, body] of [['bytes=-4', 'data'], ['bytes=6-', 'data'], ['bytes=6-100', 'data']]) {
      const ranged = await app.inject({
        url: `/api/media/${asset.id}/stream`, headers: { range: range! },
      })
      expect(ranged.statusCode).toBe(206)
      expect(ranged.body).toBe(body)
    }
    for (const range of ['bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=4-2', 'bytes=0-1,4-5', 'bytes=9007199254740992-']) {
      const invalid = await app.inject({
        url: `/api/media/${asset.id}/stream`, headers: { range },
      })
      expect(invalid.statusCode).toBe(416)
      expect(invalid.headers['content-range']).toBe('bytes */10')
    }
    const whole = await app.inject({ url: `/api/media/${asset.id}/stream` })
    expect(whole.statusCode).toBe(200)
    expect(whole.headers['content-type']).toBe('audio/mpeg')
    expect(whole.headers['content-length']).toBe('10')
    expect(whole.body).toBe('audio-data')
  })

  it('enforces optional room authorization before reading storage and never exposes cloud paths', async () => {
    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    const asset = await media.create({
      relativePath: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg', sizeBytes: 5,
    })
    const storage: MediaStorage = {
      info: { kind: 'azure-blob', container: 'songs' },
      write: vi.fn(),
      read: vi.fn(),
      stat: vi.fn(),
      delete: vi.fn(),
    }
    const app = Fastify()
    const authorize = vi.fn(async () => false)
    await registerMediaRoutes(app, media, 'unused', storage, authorize)
    cleanups.push(async () => { await app.close(); database.close() })
    const denied = await app.inject({ url: `/api/media/${asset.id}/stream` })
    expect(denied.statusCode).toBe(403)
    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: asset.id }))
    expect(storage.stat).not.toHaveBeenCalled()
    expect((await app.inject({ url: '/api/media/library' })).json()).toEqual({
      kind: 'azure-blob', container: 'songs',
    })
    authorize.mockRejectedValueOnce(new Error('credential=do-not-expose'))
    const failed = await app.inject({ url: `/api/media/${asset.id}/stream` })
    expect(failed.statusCode).toBe(500)
    expect(failed.body).not.toContain('do-not-expose')
    expect(storage.stat).not.toHaveBeenCalled()
  })

  it('distinguishes missing files, invalid paths and storage outages without deleting records', async () => {
    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    const missing = await media.create({
      relativePath: 'songs/missing.mp3', originalName: 'missing.mp3', mimeType: 'audio/mpeg', sizeBytes: 5,
    })
    const invalid = await media.create({
      relativePath: '../private.mp3', originalName: 'private.mp3', mimeType: 'audio/mpeg', sizeBytes: 5,
    })
    const app = Fastify()
    const storage = new FilesystemMediaStorage(process.cwd())
    await registerMediaRoutes(app, media, process.cwd(), storage)
    cleanups.push(async () => { await app.close(); database.close() })
    expect((await app.inject({ url: `/api/media/${missing.id}/stream` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/media/${invalid.id}/stream` })).statusCode).toBe(400)
    vi.spyOn(storage, 'stat').mockRejectedValue(new Error('Blob service unavailable'))
    expect((await app.inject({ url: `/api/media/${missing.id}/stream` })).statusCode).toBe(500)
    vi.spyOn(storage, 'delete').mockRejectedValue(new Error('Blob service unavailable'))
    expect((await app.inject({ method: 'DELETE', url: `/api/media/${missing.id}` })).statusCode).toBe(500)
    expect(await media.get(missing.id)).toBeDefined()
  })

  it('cleans up an upload when the database fails, and logs a failed compensating deletion', async () => {
    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    vi.spyOn(media, 'commitUploaded').mockRejectedValue(new Error('Database unavailable'))
    const storage: MediaStorage = {
      info: { kind: 'azure-blob', container: 'songs' },
      write: vi.fn(async (_key, source) => {
        for await (const _chunk of source) { /* Consume the reserved upload. */ }
        return 5
      }),
      read: vi.fn(),
      stat: vi.fn(),
      delete: vi.fn(async () => { throw new Error('Deletion unavailable') }),
    }
    const app = Fastify()
    const logged = vi.spyOn(app.log, 'error')
    await app.register(multipart)
    await registerMediaRoutes(app, media, 'unused', storage)
    cleanups.push(async () => { await app.close(); database.close() })
    const boundary = 'media-test'
    const response = await app.inject({
      method: 'POST', url: '/api/media',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="test.mp3"',
        'Content-Type: audio/mpeg', '', 'audio', `--${boundary}--`, '',
      ].join('\r\n'),
    })
    expect(response.statusCode).toBe(500)
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up media after upload failure')
  })

  it('stores a streamed upload with its original filename and MIME type', async () => {
    const contentRoot = await fs.promises.mkdtemp(path.join(process.cwd(), '.test-media-upload-'))
    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    const app = Fastify()
    await app.register(multipart)
    await registerMediaRoutes(app, media, contentRoot)
    cleanups.push(async () => {
      await app.close()
      database.close()
      await fs.promises.rm(contentRoot, { recursive: true, force: true })
    })
    const boundary = 'media-upload'
    const payload = (mimeType: string) => [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="Opening.mp3"',
      `Content-Type: ${mimeType}`, '', 'audio', `--${boundary}--`, '',
    ].join('\r\n')
    const response = await app.inject({
      method: 'POST', url: '/api/media',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: payload('audio/mpeg'),
    })
    expect(response.statusCode).toBe(201)
    const asset = response.json<{ id: string; relativePath: string }>()
    expect(await media.get(asset.id)).toMatchObject({
      originalName: 'Opening.mp3', mimeType: 'audio/mpeg', sizeBytes: 5,
    })
    expect(asset.relativePath).toBe(path.join('songs', path.basename(asset.relativePath)))
    expect(await fs.promises.readFile(path.join(contentRoot, asset.relativePath), 'utf8')).toBe('audio')
    const unsupported = await app.inject({
      method: 'POST', url: '/api/media',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: payload('application/octet-stream'),
    })
    expect(unsupported.statusCode).toBe(415)
    expect(await media.list()).toHaveLength(1)
  })

  it('rejects referenced cloud deletion before touching storage and retains metadata if absence is unconfirmed', async () => {
    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    const asset = await media.create({
      relativePath: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg', sizeBytes: 5,
    })
    const storage: MediaStorage = {
      info: { kind: 'azure-blob', container: 'songs' },
      write: vi.fn(), read: vi.fn(), stat: vi.fn(async () => ({ sizeBytes: 5 })), delete: vi.fn(async () => {}),
    }
    const app = Fastify()
    await registerMediaRoutes(app, media, 'unused', storage)
    cleanups.push(async () => { await app.close(); database.close() })
    const begin = vi.spyOn(media, 'beginDelete').mockRejectedValueOnce(new DomainError('media_referenced', 'secret detail'))
    const finish = vi.spyOn(media, 'finishDelete')
    const conflict = await app.inject({ method: 'DELETE', url: `/api/media/${asset.id}` })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.body).not.toContain('secret detail')
    expect(storage.delete).not.toHaveBeenCalled()
    const incomplete = await app.inject({ method: 'DELETE', url: `/api/media/${asset.id}` })
    expect(incomplete.statusCode).toBe(500)
    expect(begin).toHaveBeenCalledTimes(2)
    expect(finish).not.toHaveBeenCalled()
    expect(await media.get(asset.id)).toBeDefined()
    expect((await media.pendingCleanup()).items).toHaveLength(1)
  })

  it('returns a quota response without accepting an unreserved upload chunk', async () => {
    const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.test-media-quota-'))
    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    vi.spyOn(media, 'growReservation').mockRejectedValue(new DomainError('quota_exceeded', 'internal quota detail'))
    const app = Fastify()
    await app.register(multipart)
    await registerMediaRoutes(app, media, root)
    cleanups.push(async () => { await app.close(); database.close(); await fs.promises.rm(root, { recursive: true, force: true }) })
    const boundary = 'quota-test'
    const response = await app.inject({
      method: 'POST', url: '/api/media',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="test.mp3"',
        'Content-Type: audio/mpeg', '', 'audio', `--${boundary}--`, '',
      ].join('\r\n'),
    })
    expect(response.statusCode).toBe(413)
    expect(response.body).not.toContain('internal quota detail')
    expect(await media.list()).toHaveLength(0)
    expect((await media.pendingCleanup()).items).toHaveLength(0)
    expect(await fs.promises.readdir(path.join(root, 'songs'))).toHaveLength(0)
  })
})
