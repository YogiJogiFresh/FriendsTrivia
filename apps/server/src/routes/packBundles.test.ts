import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openDatabase } from '../database.js'
import { DomainError, type MediaOwner } from '../domain.js'
import { MediaRepository } from '../repositories/media.js'
import { PackRepository } from '../repositories/packs.js'
import { FilesystemMediaStorage, type MediaStorage } from '../storage/media.js'
import { createPackBundle, importPackBundle, registerPackBundleRoutes } from './packBundles.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('portable pack bundles', () => {
  it('spools cloud bundles in temporary storage without writing to the app directory', async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-cloud-spool-'))
    const database = openDatabase(':memory:')
    cleanups.push(() => {
      database.close()
      fs.rmSync(root, { recursive: true, force: true })
    })
    const packs = new PackRepository(database)
    const media = new MediaRepository(database)
    const created = await packs.create({ title: 'Cloud scratch' }) as { id: string }
    const pack = await packs.get(created.id) as Parameters<typeof createPackBundle>[0]
    const storage: MediaStorage = {
      info: { kind: 'azure-blob', container: 'songs' },
      write: async () => { throw new Error('Unexpected media write') },
      read: async () => { throw new Error('Unexpected media read') },
      stat: async () => undefined,
      delete: async () => { throw new Error('Unexpected media deletion') },
    }
    const appDirectory = path.join(root, 'readonly-app')
    vi.spyOn(process, 'cwd').mockReturnValue(appDirectory)
    vi.spyOn(os, 'tmpdir').mockReturnValue(root)
    const bundle = await createPackBundle(pack, media, root, { storage })
    expect(unzipSync(bundle)['pack.json']).toBeDefined()
    expect(fs.existsSync(appDirectory)).toBe(false)
    expect(fs.existsSync(path.join(root, 'friends-trivia-bundles'))).toBe(true)
  })

  it('exports referenced songs and restores clue media links on import', async () => {
    const sourceRoot = fs.mkdtempSync(path.join(process.cwd(), '.test-export-'))
    const targetRoot = fs.mkdtempSync(path.join(process.cwd(), '.test-import-'))
    fs.mkdirSync(path.join(sourceRoot, 'songs'))
    fs.mkdirSync(path.join(targetRoot, 'songs'))
    const sourceDatabase = openDatabase(':memory:')
    const targetDatabase = openDatabase(':memory:')
    cleanups.push(() => {
      sourceDatabase.close()
      targetDatabase.close()
      fs.rmSync(sourceRoot, { recursive: true, force: true })
      fs.rmSync(targetRoot, { recursive: true, force: true })
    })

    const sourcePacks = new PackRepository(sourceDatabase)
    const sourceMedia = new MediaRepository(sourceDatabase)
    fs.writeFileSync(path.join(sourceRoot, 'songs', 'opening.mp3'), 'song bytes')
    const song = await sourceMedia.create({
      relativePath: path.join('songs', 'opening.mp3'),
      originalName: 'Opening.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 10,
    })
    const created = await sourcePacks.create({ title: 'Portable Party' }) as { id: string }
    await sourcePacks.replace(created.id, {
      title: 'Portable Party',
      status: 'ready',
      categories: [
        {
          title: 'Music',
          clues: [
            {
              type: 'music_free_text',
              boardValue: 100,
              prompt: 'Name it',
              mediaAssetId: song.id,
              revealMediaAssetId: song.id,
              config: { correctAnswer: 'Answer',
                mediaPlayback: { delaySeconds: 2, playCount: 3 },
                revealMediaPlayback: { delaySeconds: 1, playCount: 1 } },
            },
          ],
        },
      ],
    })

    const bundle = await createPackBundle(
      await sourcePacks.get(created.id) as Parameters<typeof createPackBundle>[0],
      sourceMedia,
      sourceRoot,
    )
    const targetPacks = new PackRepository(targetDatabase)
    const targetMedia = new MediaRepository(targetDatabase)
    const imported = await importPackBundle(bundle, targetPacks, targetMedia, targetRoot) as {
      status: string
      categories: Array<{
        clues: Array<{ mediaAssetId: string; revealMediaAssetId: string; config: unknown }>
      }>
    }

    const importedClue = imported.categories[0]?.clues[0]
    expect(imported.status).toBe('ready')
    expect(importedClue?.mediaAssetId).toBeTruthy()
    expect(importedClue?.mediaAssetId).not.toBe(song.id)
    expect(importedClue?.revealMediaAssetId).toBe(importedClue?.mediaAssetId)
    expect(importedClue?.config).toMatchObject({
      mediaPlayback: { delaySeconds: 2, playCount: 3 },
      revealMediaPlayback: { delaySeconds: 1, playCount: 1 },
    })
    const importedMedia = await targetMedia.get(importedClue?.mediaAssetId ?? '')
    expect(importedMedia).toMatchObject({
      originalName: 'Opening.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 10,
    })
    expect(
      fs.readFileSync(path.join(targetRoot, importedMedia?.relativePath ?? ''), 'utf8'),
    ).toBe('song bytes')
  })

  it('rejects malformed bundles', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-invalid-bundle-'))
    fs.mkdirSync(path.join(root, 'songs'))
    cleanups.push(() => {
      database.close()
      fs.rmSync(root, { recursive: true, force: true })
    })

    await expect(
      importPackBundle(
        new Uint8Array([1, 2, 3]),
        new PackRepository(database),
        new MediaRepository(database),
        root,
      ),
    ).rejects.toThrow()
  })

  it('deduplicates byte-identical songs in optimized exports', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-optimized-export-'))
    fs.mkdirSync(path.join(root, 'songs'))
    cleanups.push(() => {
      database.close()
      fs.rmSync(root, { recursive: true, force: true })
    })
    const media = new MediaRepository(database)
    const contents = Buffer.from('same audio bytes '.repeat(200))
    fs.writeFileSync(path.join(root, 'songs', 'clue.mp3'), contents)
    fs.writeFileSync(path.join(root, 'songs', 'answer.mp3'), contents)
    const clueSong = await media.create({
      relativePath: path.join('songs', 'clue.mp3'),
      originalName: 'Clue.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: contents.byteLength,
    })
    const answerSong = await media.create({
      relativePath: path.join('songs', 'answer.mp3'),
      originalName: 'Answer.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: contents.byteLength,
    })
    const pack = {
      title: 'Optimized',
      categories: [
        {
          title: 'Music',
          clues: [
            {
              type: 'music_free_text',
              boardValue: 100,
              prompt: 'Name it',
              mediaAssetId: clueSong.id,
              revealMediaAssetId: answerSong.id,
              config: { correctAnswer: 'Answer' },
            },
          ],
        },
      ],
    }

    const standard = await createPackBundle(pack, media, root)
    const optimized = await createPackBundle(pack, media, root, { optimized: true })
    const files = unzipSync(optimized)

    expect(Object.keys(files).filter((name) => name.startsWith('songs/'))).toHaveLength(1)
    expect(optimized.byteLength).toBeLessThan(standard.byteLength)
  })

  it('rejects legacy JSON uploads at the bundle endpoint', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-json-rejection-'))
    fs.mkdirSync(path.join(root, 'songs'))
    const app = Fastify()
    await app.register(multipart)
    await registerPackBundleRoutes(
      app,
      new PackRepository(database),
      new MediaRepository(database),
      root,
    )
    cleanups.push(async () => {
      await app.close()
      database.close()
      fs.rmSync(root, { recursive: true, force: true })
    })

    const boundary = 'friends-trivia-test'
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="legacy.json"',
      'Content-Type: application/json',
      '',
      '{}',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const response = await app.inject({
      method: 'POST',
      url: '/api/packs/import-bundle',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: 'Pack imports must use a .friendstrivia bundle',
    })
  })

  it('validates missing and duplicate media before writing storage', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-validation-'))
    const storage = new FilesystemMediaStorage(root)
    const write = vi.spyOn(storage, 'write')
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const pack = {
      title: 'Invalid', categories: [{
        title: 'Music', clues: [{
          type: 'music_free_text', boardValue: 100, prompt: 'Name it', mediaAssetId: 'song',
          config: { correctAnswer: 'Answer' },
        }],
      }],
    }
    const entry = { sourceId: 'song', fileName: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg' }
    for (const media of [[], [entry, entry], [{ ...entry, fileName: 'songs/missing.mp3' }]]) {
      const bundle = zipSync({
        'pack.json': strToU8(JSON.stringify({ schemaVersion: 2, pack, media })),
        'songs/song.mp3': strToU8('audio'),
      })
      await expect(importPackBundle(bundle, new PackRepository(database), new MediaRepository(database), root, storage))
        .rejects.toThrow()
    }
    expect(write).not.toHaveBeenCalled()
    const malformed = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'Malformed', categories: [null] }, media: [],
      })),
    })
    await expect(importPackBundle(malformed, new PackRepository(database), new MediaRepository(database), root, storage))
      .rejects.toThrow('Invalid or unsupported')
  })

  it('rolls back created pack/media/storage after pack validation fails', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-cleanup-'))
    const packs = new PackRepository(database)
    const media = new MediaRepository(database)
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const bundle = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2,
        pack: {
          title: 'Invalid', categories: [{
            title: 'Music', clues: [{
              type: 'music_free_text', boardValue: -1, prompt: 'Name it', mediaAssetId: 'song',
              config: { correctAnswer: 'Answer' },
            }],
          }],
        },
        media: [{ sourceId: 'song', fileName: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg' }],
      })),
      'songs/song.mp3': strToU8('audio'),
    })
    await expect(importPackBundle(bundle, packs, media, root)).rejects.toThrow('positive integers')
    expect(await packs.list()).toHaveLength(0)
    expect(await media.list()).toHaveLength(0)
    expect(await fs.promises.readdir(path.join(root, 'songs'))).toHaveLength(0)
  })

  it('cleans up a newly written object on DB failure and explicitly logs failed cleanup', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-db-failure-'))
    const media = new MediaRepository(database)
    const storage = new FilesystemMediaStorage(root)
    const logged = vi.fn()
    const remove = vi.spyOn(storage, 'delete').mockRejectedValue(new Error('Cleanup unavailable'))
    vi.spyOn(media, 'commitUploaded').mockRejectedValue(new Error('Database unavailable'))
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const bundle = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'DB error', categories: [] },
        media: [{ sourceId: 'song', fileName: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg' }],
      })),
      'songs/song.mp3': strToU8('audio'),
    })
    await expect(importPackBundle(bundle, new PackRepository(database), media, root, storage, { error: logged }))
      .rejects.toThrow('Database unavailable')
    expect(remove).toHaveBeenCalledOnce()
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }),
      'Failed to remove imported media storage object')
    expect(await media.list()).toHaveLength(0)
    expect((await media.pendingCleanup()).items).toHaveLength(1)
  })

  it('reserves every expanded song before writing and aborts all holds on quota rejection', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-quota-'))
    const media = new MediaRepository(database)
    const storage = new FilesystemMediaStorage(root)
    const write = vi.spyOn(storage, 'write')
    const originalGrow = media.growReservation.bind(media)
    vi.spyOn(media, 'growReservation').mockImplementationOnce(originalGrow)
      .mockRejectedValueOnce(new DomainError('quota_exceeded', 'Quota exceeded'))
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const bundle = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'Quota', categories: [] },
        media: ['one', 'two'].map((sourceId) => ({
          sourceId, fileName: `songs/${sourceId}.mp3`, originalName: `${sourceId}.mp3`, mimeType: 'audio/mpeg',
        })),
      })),
      'songs/one.mp3': strToU8('first'), 'songs/two.mp3': strToU8('second'),
    })
    await expect(importPackBundle(bundle, new PackRepository(database), media, root, storage))
      .rejects.toMatchObject({ code: 'quota_exceeded' })
    expect(write).not.toHaveBeenCalled()
    expect((await media.pendingCleanup()).items).toHaveLength(0)
    expect(await media.list()).toHaveLength(0)
  })

  it('retains committed metadata when rollback cannot delete its song', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-retain-'))
    const media = new MediaRepository(database)
    const packs = new PackRepository(database)
    const storage = new FilesystemMediaStorage(root)
    vi.spyOn(packs, 'replace').mockRejectedValue(new Error('Publication unavailable'))
    vi.spyOn(storage, 'delete').mockRejectedValue(new Error('Deletion unavailable'))
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const bundle = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'Retained', categories: [] },
        media: [{ sourceId: 'song', fileName: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg' }],
      })),
      'songs/song.mp3': strToU8('audio'),
    })
    await expect(importPackBundle(bundle, packs, media, root, storage, { error: vi.fn() }))
      .rejects.toThrow('Publication unavailable')
    const assets = await media.list()
    expect(assets).toHaveLength(1)
    expect(await storage.stat(assets[0]!.relativePath)).toEqual({ sizeBytes: 5 })
    expect((await media.pendingCleanup()).items).toHaveLength(1)
  })

  it('holds one operation owner across imported songs until publication, then releases bounded pages', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-claims-'))
    const media = new MediaRepository(database)
    const packs = new PackRepository(database)
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const owners: MediaOwner[] = []
    const commit = media.commitUploaded.bind(media)
    vi.spyOn(media, 'commitUploaded').mockImplementation(async (reservation, input, bytes, owner) => {
      expect(owner).toMatchObject({ kind: 'operation', id: expect.any(String) })
      owners.push(owner!)
      return commit(reservation, input, bytes, owner)
    })
    let published = false
    let acknowledged = false
    let released = false
    const complete = vi.spyOn(media, 'completeOperation').mockImplementation(async (owner) => {
      expect(published).toBe(true)
      expect(released).toBe(false)
      expect(owner).toEqual(owners[0])
      acknowledged = true
    })
    vi.spyOn(media, 'beginDelete').mockImplementation(async () => {
      if (!released) throw new DomainError('media_referenced', 'Operation owns this song')
      throw new Error('Unexpected deletion after publication')
    })
    const replace = packs.replace.bind(packs)
    vi.spyOn(packs, 'replace').mockImplementation(async (...args) => {
      expect(owners).toHaveLength(2)
      expect(args[2]).toEqual(owners[0])
      await expect(media.beginDelete('song', 'public-delete')).rejects.toMatchObject({ code: 'media_referenced' })
      const pack = await replace(...args)
      published = true
      return pack
    })
    const release = vi.spyOn(media, 'releaseClaims').mockImplementation(async (owner, page) => {
      expect(published).toBe(true)
      expect(acknowledged).toBe(true)
      expect(owner).toEqual(owners[0])
      expect(page).toEqual({ limit: 100 })
      if (!released) { released = true; return { done: false } }
      return { done: true }
    })
    const bundle = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'Owned import', categories: [] },
        media: ['one', 'two'].map((sourceId) => ({
          sourceId, fileName: `songs/${sourceId}.mp3`, originalName: `${sourceId}.mp3`, mimeType: 'audio/mpeg',
        })),
      })),
      'songs/one.mp3': strToU8('first'), 'songs/two.mp3': strToU8('second'),
    })
    await importPackBundle(bundle, packs, media, root)
    expect(owners[1]).toEqual(owners[0])
    expect(release).toHaveBeenCalledTimes(2)
    expect(complete).toHaveBeenCalledOnce()
    expect(await media.list()).toHaveLength(2)
  })

  it.each([false, true])('retains owned songs if claim release fails (published=%s)', async (published) => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-held-claims-'))
    const media = new MediaRepository(database)
    const packs = new PackRepository(database)
    const storage = new FilesystemMediaStorage(root)
    const remove = vi.spyOn(storage, 'delete')
    const logged = vi.fn()
    vi.spyOn(media, 'releaseClaims').mockRejectedValue(new Error('Claim release unavailable'))
    if (!published) vi.spyOn(packs, 'replace').mockRejectedValue(new Error('Publication unavailable'))
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const bundle = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'Held import', categories: [] },
        media: [{ sourceId: 'song', fileName: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg' }],
      })),
      'songs/song.mp3': strToU8('audio'),
    })
    const result = importPackBundle(bundle, packs, media, root, storage, { error: logged })
    if (published) await expect(result).resolves.toMatchObject({ title: 'Held import' })
    else await expect(result).rejects.toThrow('Publication unavailable')
    expect(remove).not.toHaveBeenCalled()
    expect(await media.list()).toHaveLength(1)
    expect(await packs.list()).toHaveLength(published ? 1 : 0)
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }),
      published ? 'Failed to release published import media claims' : 'Failed to release failed import media claims')
  })

  it('releases failed import claims before acquiring cleanup deletion tickets', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-release-rollback-'))
    const media = new MediaRepository(database)
    const packs = new PackRepository(database)
    let released = false
    vi.spyOn(packs, 'replace').mockRejectedValue(new Error('Publication unavailable'))
    vi.spyOn(media, 'releaseClaims').mockImplementation(async () => { released = true; return { done: true } })
    const begin = media.beginDelete.bind(media)
    vi.spyOn(media, 'beginDelete').mockImplementation(async (...args) => {
      expect(released).toBe(true)
      return begin(...args)
    })
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const bundle = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'Rollback import', categories: [] },
        media: [{ sourceId: 'song', fileName: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg' }],
      })),
      'songs/song.mp3': strToU8('audio'),
    })
    await expect(importPackBundle(bundle, packs, media, root)).rejects.toThrow('Publication unavailable')
    expect(await media.list()).toEqual([])
    expect((await media.pendingCleanup()).items).toEqual([])
  })

  it('does not release claims or roll back a published pack when its operation acknowledgement fails', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-ack-failure-'))
    const media = new MediaRepository(database)
    const packs = new PackRepository(database)
    const storage = new FilesystemMediaStorage(root)
    const release = vi.spyOn(media, 'releaseClaims')
    const remove = vi.spyOn(storage, 'delete')
    vi.spyOn(media, 'completeOperation').mockRejectedValue(new Error('Acknowledgement unavailable'))
    cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }) })
    const bundle = zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'Acknowledgement failure', categories: [] },
        media: [{ sourceId: 'song', fileName: 'songs/song.mp3', originalName: 'song.mp3', mimeType: 'audio/mpeg' }],
      })),
      'songs/song.mp3': strToU8('audio'),
    })
    await expect(importPackBundle(bundle, packs, media, root, storage, { error: vi.fn() }))
      .resolves.toMatchObject({ title: 'Acknowledgement failure' })
    expect(release).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(await packs.list()).toHaveLength(1)
    expect(await media.list()).toHaveLength(1)
  })

  it('imports multipart streams and exports the same bundle format with content length', async () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(process.cwd(), '.test-bundle-http-'))
    const packs = new PackRepository(database)
    const media = new MediaRepository(database)
    const app = Fastify()
    await app.register(multipart)
    await registerPackBundleRoutes(app, packs, media, root)
    cleanups.push(async () => {
      await app.close()
      database.close()
      fs.rmSync(root, { recursive: true, force: true })
    })
    const bundle = Buffer.from(zipSync({
      'pack.json': strToU8(JSON.stringify({
        schemaVersion: 2, pack: { title: 'HTTP Party', categories: [] }, media: [],
      })),
    }))
    const boundary = 'friends-trivia-stream-test'
    const response = await app.inject({
      method: 'POST', url: '/api/packs/import-bundle',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="party.friendstrivia"\r\nContent-Type: application/zip\r\n\r\n`),
        bundle, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    })
    expect(response.statusCode).toBe(201)
    const imported = response.json<{ id: string }>()
    const exported = await app.inject({ url: `/api/packs/${imported.id}/export-bundle` })
    expect(exported.statusCode).toBe(200)
    expect(exported.headers['content-type']).toBe('application/zip')
    expect(exported.headers['content-length']).toBe(String(exported.rawPayload.length))
    expect(exported.headers['content-disposition']).toBe('attachment; filename="HTTP-Party.friendstrivia"')
    const manifest = JSON.parse(Buffer.from(unzipSync(exported.rawPayload)['pack.json']!).toString())
    expect(manifest).toMatchObject({ schemaVersion: 2, pack: { title: 'HTTP Party' }, media: [] })
  })
})
