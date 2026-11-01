import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import type { ContainerClient } from '@azure/storage-blob'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_AUDIO_BYTES } from '../content.js'
import { AzureBlobMediaStorage } from './azureMedia.js'
import { createMediaStorage, FilesystemMediaStorage } from './media.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('filesystem media storage', () => {
  it('writes, ranges and deletes without overwriting an existing song', async () => {
    const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.test-storage-'))
    cleanups.push(async () => fs.promises.rm(root, { recursive: true, force: true }))
    const storage = new FilesystemMediaStorage(root)
    expect(await storage.write('songs/song.mp3', Readable.from(['audio-data']), 'audio/mpeg')).toBe(10)
    expect(await storage.stat('songs/song.mp3')).toEqual({ sizeBytes: 10 })
    let audio = ''
    for await (const chunk of await storage.read('songs/song.mp3', { start: 2, end: 6 })) audio += chunk.toString()
    expect(audio).toBe('dio-d')
    await expect(storage.write('songs/song.mp3', Readable.from(['replacement']), 'audio/mpeg')).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(await fs.promises.readFile(path.join(root, 'songs', 'song.mp3'), 'utf8')).toBe('audio-data')
    await storage.delete('songs/song.mp3')
    await storage.delete('songs/song.mp3')
    expect(await storage.stat('songs/song.mp3')).toBeUndefined()
  })

  it('bounds streaming audio and removes only its own incomplete file', async () => {
    const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.test-storage-'))
    cleanups.push(async () => fs.promises.rm(root, { recursive: true, force: true }))
    const storage = new FilesystemMediaStorage(root)
    const chunk = Buffer.alloc(1024 * 1024)
    await expect(storage.write('songs/large.mp3', Readable.from((function* () {
      for (let i = 0; i <= MAX_AUDIO_BYTES / chunk.length; i++) yield chunk
    })()), 'audio/mpeg')).rejects.toThrow('50 MB')
    expect(await storage.stat('songs/large.mp3')).toBeUndefined()
    await expect(storage.stat('../outside.mp3')).rejects.toThrow('outside')
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 'EACCES' }))
    await expect(storage.stat('songs/forbidden.mp3')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('never silently falls back when cloud configuration is invalid', async () => {
    await expect(createMediaStorage({ mode: 'cloud', contentRoot: 'unused' })).rejects.toThrow('AZURE_STORAGE_ACCOUNT_URL')
    for (const azureStorageAccountUrl of ['http://storage.example', 'https://storage.example?sig=secret', 'https://user:password@storage.example']) {
      await expect(createMediaStorage({ mode: 'cloud', contentRoot: 'unused', azureStorageAccountUrl }))
        .rejects.toThrow('HTTPS account URL without credentials')
    }
  })
})

describe('Azure Blob media storage', () => {
  function fixture() {
    const download = vi.fn(async () => ({ readableStreamBody: Readable.from(['audio']) }))
    const getProperties = vi.fn(async () => ({ contentLength: 5 }))
    const deleteIfExists = vi.fn(async () => ({ succeeded: true }))
    const uploadStream = vi.fn(async (stream: Readable) => {
      for await (const _chunk of stream) { /* Consume the bounded upload stream. */ }
      return {}
    })
    const getBlobClient = vi.fn(() => ({ download, getProperties, deleteIfExists }))
    const getBlockBlobClient = vi.fn(() => ({ uploadStream, deleteIfExists }))
    const storage = new AzureBlobMediaStorage({
      getBlobClient, getBlockBlobClient,
    } as unknown as ContainerClient)
    return { storage, download, getProperties, deleteIfExists, uploadStream, getBlobClient, getBlockBlobClient }
  }

  it('normalizes legacy Windows keys and retains private, ranged MIME-aware streaming', async () => {
    const mock = fixture()
    expect(mock.storage.info).toEqual({ kind: 'azure-blob', container: 'songs' })
    expect(await mock.storage.write('songs\\song.mp3', Readable.from(['audio']), 'audio/mpeg')).toBe(5)
    expect(mock.getBlockBlobClient).toHaveBeenCalledWith('song.mp3')
    expect(mock.uploadStream).toHaveBeenCalledWith(expect.anything(), 1024 * 1024, 2,
      expect.objectContaining({
        blobHTTPHeaders: { blobContentType: 'audio/mpeg' }, conditions: { ifNoneMatch: '*' },
      }))
    expect(await mock.storage.stat('songs/song.mp3')).toEqual({ sizeBytes: 5 })
    await mock.storage.read('songs/song.mp3', { start: 2, end: 6 })
    expect(mock.download).toHaveBeenCalledWith(2, 5)
    await mock.storage.delete('songs/song.mp3')
    expect(mock.deleteIfExists).toHaveBeenCalledOnce()
  })

  it('propagates blob outages and rejects unsafe paths or empty downloads', async () => {
    const mock = fixture()
    mock.getProperties.mockRejectedValueOnce({ statusCode: 404 })
    expect(await mock.storage.stat('songs/missing.mp3')).toBeUndefined()
    mock.getProperties.mockRejectedValueOnce(new Error('Service unavailable'))
    await expect(mock.storage.stat('songs/song.mp3')).rejects.toThrow('Service unavailable')
    mock.download.mockResolvedValueOnce({ readableStreamBody: undefined } as never)
    await expect(mock.storage.read('songs/song.mp3')).rejects.toThrow('no stream')
    mock.deleteIfExists.mockRejectedValueOnce(new Error('Forbidden'))
    await expect(mock.storage.delete('songs/song.mp3')).rejects.toThrow('Forbidden')
    await expect(mock.storage.stat('songs/../secret.mp3')).rejects.toThrow('Invalid media path')
    mock.uploadStream.mockRejectedValueOnce(new Error('Upload unavailable'))
    await expect(mock.storage.write('songs/song.mp3', Readable.from(['audio']), 'audio/mpeg'))
      .rejects.toThrow('Upload unavailable')
    expect(mock.deleteIfExists).toHaveBeenCalledTimes(2)
  })

  it.each([409, 412])('preserves the existing blob when an upload conflicts with status %i', async (statusCode) => {
    const mock = fixture()
    mock.uploadStream.mockRejectedValueOnce(Object.assign(new Error('Already exists'), { statusCode }))
    await expect(mock.storage.write('songs/song.mp3', Readable.from(['audio']), 'audio/mpeg'))
      .rejects.toThrow('Already exists')
    expect(mock.deleteIfExists).not.toHaveBeenCalled()
  })
})
