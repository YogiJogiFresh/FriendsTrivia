import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { openDatabase } from '../database.js'
import { DomainError, type MediaAsset, type MediaCleanup } from '../domain.js'
import { MediaRepository } from '../repositories/media.js'
import { FilesystemMediaStorage, type MediaStorage } from './media.js'
import { cleanupUpload, recoverMediaOperations, writeReservedMedia } from './operations.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.test-media-operations-'))
  const database = openDatabase(':memory:')
  const media = new MediaRepository(database)
  const storage = new FilesystemMediaStorage(root)
  cleanups.push(async () => { database.close(); await fs.promises.rm(root, { recursive: true, force: true }) })
  return { media, storage, root }
}

describe('media storage operation ordering', () => {
  it('awaits each reservation growth before the corresponding chunk reaches storage', async () => {
    const { media } = await fixture()
    const reservation = await media.reserveUpload('upload', ['songs/song.mp3'])
    let held = 0
    const grow = media.growReservation.bind(media)
    vi.spyOn(media, 'growReservation').mockImplementation(async (current, total) => {
      await new Promise((resolve) => setImmediate(resolve))
      const next = await grow(current, total)
      held = total
      return next
    })
    const accepted: number[] = []
    const storage: MediaStorage = {
      info: { kind: 'azure-blob', container: 'songs' },
      stat: vi.fn(), read: vi.fn(), delete: vi.fn(),
      write: async (_key, source) => {
        let bytes = 0
        for await (const chunk of source) {
          bytes += (chunk as Buffer).length
          expect(held).toBeGreaterThanOrEqual(bytes)
          accepted.push(bytes)
        }
        return bytes
      },
    }
    const written = await writeReservedMedia(media, storage, reservation, 'songs/song.mp3',
      Readable.from([Buffer.from('one'), Buffer.from('two')]), 'audio/mpeg')
    expect(accepted).toEqual([3, 6])
    expect(written.reservation.reservedBytes).toBe(6)
  })

  it('keeps a failed quota chunk out of storage while preserving earlier held bytes for cleanup', async () => {
    const { media, storage } = await fixture()
    const reservation = await media.reserveUpload('upload', ['songs/song.mp3'])
    const grow = media.growReservation.bind(media)
    vi.spyOn(media, 'growReservation').mockImplementation(async (current, total) => {
      if (total > 3) throw new DomainError('quota_exceeded', 'Quota exceeded')
      return grow(current, total)
    })
    await expect(writeReservedMedia(media, storage, reservation, 'songs/song.mp3',
      Readable.from([Buffer.from('one'), Buffer.from('two')]), 'audio/mpeg'))
      .rejects.toMatchObject({ code: 'quota_exceeded' })
    expect((await media.pendingCleanup()).items[0]).toMatchObject({ reservation: { reservedBytes: 3 } })
    await cleanupUpload(media, storage, reservation)
    expect((await media.pendingCleanup()).items).toEqual([])
  })

  it('does not release an upload until deletion and absence checks succeed, then recovers only owned keys', async () => {
    const { media, storage, root } = await fixture()
    const reservation = await media.growReservation(await media.reserveUpload('upload', ['songs/owned.mp3']), 5)
    await storage.write('songs/owned.mp3', Readable.from(['audio']), 'audio/mpeg')
    await fs.promises.writeFile(path.join(root, 'songs', 'unowned.mp3'), 'keep')
    const stat = vi.spyOn(storage, 'stat').mockResolvedValueOnce({ sizeBytes: 5 })
    await expect(cleanupUpload(media, storage, reservation)).rejects.toThrow('still exists')
    expect((await media.pendingCleanup()).items).toHaveLength(1)
    stat.mockRestore()
    await recoverMediaOperations(media, storage)
    expect((await media.pendingCleanup()).items).toEqual([])
    expect(await fs.promises.readFile(path.join(root, 'songs', 'unowned.mp3'), 'utf8')).toBe('keep')
  })

  it('recovers committed metadata after a lost response and retries failed deletion metadata commits', async () => {
    const { media, storage } = await fixture()
    const reservation = await media.growReservation(await media.reserveUpload('upload', ['songs/owned.mp3']), 5)
    await storage.write('songs/owned.mp3', Readable.from(['audio']), 'audio/mpeg')
    const asset = await media.commitUploaded(reservation, {
      relativePath: 'songs/owned.mp3', originalName: 'owned.mp3', mimeType: 'audio/mpeg', sizeBytes: 5,
    }, 5)
    vi.spyOn(media, 'finishDelete').mockRejectedValueOnce(new Error('Metadata unavailable'))
    await expect(cleanupUpload(media, storage, reservation)).rejects.toThrow('Metadata unavailable')
    expect(await storage.stat('songs/owned.mp3')).toBeUndefined()
    expect(await media.get(asset.id)).toBeDefined()
    await recoverMediaOperations(media, storage)
    expect(await media.get(asset.id)).toBeUndefined()
    expect((await media.pendingCleanup()).items).toEqual([])
  })

  it('keeps a failed concurrent operation owned while another upload commits', async () => {
    const { media, storage } = await fixture()
    const failed = await media.reserveUpload('failed', ['songs/failed.mp3'])
    const successful = await media.reserveUpload('successful', ['songs/successful.mp3'])
    const grow = media.growReservation.bind(media)
    vi.spyOn(media, 'growReservation').mockImplementation(async (current, total) => {
      if (current.id === 'failed') throw new DomainError('quota_exceeded', 'Quota exceeded')
      return grow(current, total)
    })
    const results = await Promise.allSettled([
      writeReservedMedia(media, storage, failed, 'songs/failed.mp3', Readable.from(['audio']), 'audio/mpeg'),
      writeReservedMedia(media, storage, successful, 'songs/successful.mp3', Readable.from(['audio']), 'audio/mpeg'),
    ])
    expect(results[0]!.status).toBe('rejected')
    expect(results[1]!.status).toBe('fulfilled')
    if (results[1]!.status !== 'fulfilled') throw new Error('Successful upload failed')
    const asset = await media.commitUploaded(results[1].value.reservation, {
      relativePath: 'songs/successful.mp3', originalName: 'successful.mp3', mimeType: 'audio/mpeg', sizeBytes: 5,
    }, 5)
    await cleanupUpload(media, storage, failed)
    expect(await media.get(asset.id)).toBeDefined()
    expect(await storage.stat(asset.relativePath)).toEqual({ sizeBytes: 5 })
    expect((await media.pendingCleanup()).items).toEqual([])
  })

  it('recovers operation-owned songs across empty pages without deleting published references', async () => {
    const { media, storage } = await fixture()
    const keys = ['songs/orphan.mp3', 'songs/published.mp3']
    const assets: MediaAsset[] = []
    for (const key of keys) {
      const reservation = await media.growReservation(await media.reserveUpload(key, [key]), 5)
      await storage.write(key, Readable.from(['audio']), 'audio/mpeg')
      assets.push(await media.commitUploaded(reservation, {
        relativePath: key, originalName: key, mimeType: 'audio/mpeg', sizeBytes: 5,
      }, 5))
    }
    const operation: MediaCleanup = { kind: 'operation', owner: { kind: 'operation', id: 'interrupted-import' }, ownedKeys: keys }
    const complete = vi.spyOn(media, 'completeOperation')
    const pending = vi.spyOn(media, 'pendingCleanup')
      .mockResolvedValueOnce({ items: [], cursor: 'next-page' })
      .mockResolvedValueOnce({ items: [operation] })
    let released = false
    const release = vi.spyOn(media, 'releaseClaims').mockImplementation(async (owner, page) => {
      expect(owner).toEqual(operation.owner)
      expect(page).toEqual({ limit: 100 })
      released = true
      return { done: true }
    })
    const begin = media.beginDelete.bind(media)
    vi.spyOn(media, 'beginDelete').mockImplementation(async (id, operationId) => {
      expect(released).toBe(true)
      if (id === assets[1]!.id) throw new DomainError('media_referenced', 'Published reference')
      return begin(id, operationId)
    })
    await recoverMediaOperations(media, storage)
    expect(pending).toHaveBeenNthCalledWith(2, { limit: 100, cursor: 'next-page' })
    expect(release).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(operation.owner)
    expect(await media.get(assets[0]!.id)).toBeUndefined()
    expect(await media.get(assets[1]!.id)).toBeDefined()
    expect(await storage.stat(keys[0]!)).toBeUndefined()
    expect(await storage.stat(keys[1]!)).toEqual({ sizeBytes: 5 })
  })

  it('retains operation recovery ownership through cleanup failure and prunes only after retry', async () => {
    const { media, storage } = await fixture()
    const key = 'songs/interrupted.mp3'
    const reservation = await media.growReservation(await media.reserveUpload('upload', [key]), 5)
    await storage.write(key, Readable.from(['audio']), 'audio/mpeg')
    const asset = await media.commitUploaded(reservation, {
      relativePath: key, originalName: key, mimeType: 'audio/mpeg', sizeBytes: 5,
    }, 5)
    const operation: MediaCleanup = { kind: 'operation', owner: { kind: 'operation', id: 'interrupted-import' }, ownedKeys: [key] }
    let journal = true
    vi.spyOn(media, 'pendingCleanup').mockImplementation(async () => ({ items: journal ? [operation] : [] }))
    const release = vi.spyOn(media, 'releaseClaims').mockImplementation(async () => {
      return { done: true }
    })
    const complete = vi.spyOn(media, 'completeOperation').mockImplementation(async () => {
      expect(await media.findByPath(key)).toBeUndefined()
      journal = false
    })
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(recoverMediaOperations(media, storage)).rejects.toThrow('Storage unavailable')
    expect(journal).toBe(true)
    expect(await media.get(asset.id)).toBeDefined()
    expect(release).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()
    await recoverMediaOperations(media, storage)
    expect(release).toHaveBeenCalledTimes(2)
    expect(complete).toHaveBeenCalledOnce()
    expect(journal).toBe(false)
    expect(await media.get(asset.id)).toBeUndefined()
    expect(await storage.stat(key)).toBeUndefined()
  })

  it('only releases published operation holds and preserves even unreferenced imported songs', async () => {
    const { media, storage } = await fixture()
    const key = 'songs/published-unused.mp3'
    const reservation = await media.growReservation(await media.reserveUpload('upload', [key]), 5)
    await storage.write(key, Readable.from(['audio']), 'audio/mpeg')
    const asset = await media.commitUploaded(reservation, {
      relativePath: key, originalName: key, mimeType: 'audio/mpeg', sizeBytes: 5,
    }, 5)
    const operation: MediaCleanup = {
      kind: 'operation', owner: { kind: 'operation', id: 'published-import' }, ownedKeys: [key], published: true,
    }
    vi.spyOn(media, 'pendingCleanup').mockResolvedValue({ items: [operation] })
    const release = vi.spyOn(media, 'releaseClaims').mockResolvedValueOnce({ done: false }).mockResolvedValueOnce({ done: true })
    const begin = vi.spyOn(media, 'beginDelete')
    const remove = vi.spyOn(storage, 'delete')
    const complete = vi.spyOn(media, 'completeOperation')
    await recoverMediaOperations(media, storage)
    expect(release).toHaveBeenCalledTimes(2)
    expect(begin).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(await media.get(asset.id)).toBeDefined()
    expect(await storage.stat(key)).toEqual({ sizeBytes: 5 })
  })
})
