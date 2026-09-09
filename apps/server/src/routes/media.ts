import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { FastifyInstance } from 'fastify'

import {
  MAX_AUDIO_BYTES,
  audioExtension,
  resolveContentPath,
} from '../content.js'
import { createId } from '../ids.js'
import type { MediaRepository } from '../repositories/media.js'

interface MediaParams {
  id: string
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  media: MediaRepository,
  contentRoot: string,
): Promise<void> {
  app.get('/api/media', async () => media.list())
  app.get('/api/media/library', async () => ({
    directory: resolveContentPath(contentRoot, 'songs'),
  }))

  app.post('/api/media', async (request, reply) => {
    const upload = await request.file({
      limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
    })
    if (!upload) return reply.code(400).send({ error: 'An audio file is required' })

    const extension = audioExtension(upload.mimetype)
    if (!extension) {
      upload.file.resume()
      return reply.code(415).send({ error: 'Supported formats are MP3, M4A, OGG, and WAV' })
    }

    const relativePath = path.join('songs', `${createId()}${extension}`)
    const absolutePath = resolveContentPath(contentRoot, relativePath)
    await pipeline(upload.file, fs.createWriteStream(absolutePath, { flags: 'wx' }))
    const stats = await fs.promises.stat(absolutePath)

    if (upload.file.truncated) {
      await fs.promises.unlink(absolutePath)
      return reply.code(413).send({ error: 'Audio file exceeds the 50 MB limit' })
    }

    const asset = media.create({
      relativePath,
      originalName: path.basename(upload.filename),
      mimeType: upload.mimetype,
      sizeBytes: stats.size,
    })
    return reply.code(201).send(asset)
  })

  app.get<{ Params: MediaParams }>('/api/media/:id/stream', async (request, reply) => {
    const asset = media.get(request.params.id)
    if (!asset) return reply.code(404).send({ error: 'Media asset not found' })

    let absolutePath: string
    try {
      absolutePath = resolveContentPath(contentRoot, asset.relativePath)
    } catch {
      return reply.code(400).send({ error: 'Invalid media path' })
    }

    const stats = await fs.promises.stat(absolutePath).catch(() => undefined)
    if (!stats?.isFile()) return reply.code(404).send({ error: 'Media file not found' })

    const range = request.headers.range
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', asset.mimeType)
    if (!range) {
      reply.header('Content-Length', stats.size)
      return reply.send(fs.createReadStream(absolutePath))
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) return reply.code(416).header('Content-Range', `bytes */${stats.size}`).send()

    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Number(match[2]) : stats.size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= stats.size) {
      return reply.code(416).header('Content-Range', `bytes */${stats.size}`).send()
    }

    reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${stats.size}`)
      .header('Content-Length', end - start + 1)
    return reply.send(fs.createReadStream(absolutePath, { start, end }))
  })

  app.delete<{ Params: MediaParams }>('/api/media/:id', async (request, reply) => {
    const asset = media.get(request.params.id)
    if (!asset) return reply.code(404).send({ error: 'Media asset not found' })

    let absolutePath: string
    try {
      absolutePath = resolveContentPath(contentRoot, asset.relativePath)
    } catch {
      return reply.code(400).send({ error: 'Invalid media path' })
    }

    try {
      await fs.promises.unlink(absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return reply.code(500).send({ error: 'Could not remove the media file' })
      }
    }
    media.remove(asset.id)
    return reply.code(204).send()
  })
}
