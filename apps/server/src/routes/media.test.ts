import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../database.js'
import { MediaRepository } from '../repositories/media.js'
import { registerMediaRoutes } from './media.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('media library', () => {
  it('reports the song directory and removes a song file and record', async () => {
    const contentRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'friends-trivia-media-'))
    const songsDirectory = path.join(contentRoot, 'songs')
    await fs.promises.mkdir(songsDirectory)
    const songPath = path.join(songsDirectory, 'test.mp3')
    await fs.promises.writeFile(songPath, 'audio')

    const database = openDatabase(':memory:')
    const media = new MediaRepository(database)
    const asset = media.create({
      relativePath: path.join('songs', 'test.mp3'),
      originalName: 'test.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 5,
    })
    const app = Fastify()
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
    expect(media.get(asset.id)).toBeUndefined()
    await expect(fs.promises.stat(songPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
