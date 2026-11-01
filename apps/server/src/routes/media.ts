import path from 'node:path'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  MAX_AUDIO_BYTES,
  audioExtension,
} from '../content.js'
import { createId } from '../ids.js'
import { DomainError, type UploadReservation } from '../domain.js'
import type { MediaAsset, MediaRepository } from '../repositories/media.js'
import { FilesystemMediaStorage, type MediaStorage } from '../storage/media.js'
import { cleanupUpload, deleteMediaObject, writeReservedMedia } from '../storage/operations.js'

interface MediaParams {
  id: string
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  media: MediaRepository,
  contentRoot: string,
  storage: MediaStorage = new FilesystemMediaStorage(contentRoot),
  authorizeStream?: (request: FastifyRequest, asset: MediaAsset) => Promise<boolean>,
): Promise<void> {
  app.get('/api/media', async () => media.list())
  app.get('/api/media/library', async () => storage.info.kind === 'filesystem'
    ? { directory: storage.info.directory }
    : storage.info)

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
    let reservation: UploadReservation | undefined
    try {
      reservation = await media.reserveUpload(createId(), [relativePath])
      const written = await writeReservedMedia(media, storage, reservation, relativePath, upload.file, upload.mimetype)
      reservation = written.reservation
      const sizeBytes = written.sizeBytes
      if (upload.file.truncated) throw new Error('Audio file exceeds the 50 MB limit')
      const asset = await media.commitUploaded(reservation, {
        relativePath,
        originalName: path.basename(upload.filename.replaceAll('\\', '/')),
        mimeType: upload.mimetype,
        sizeBytes,
      }, sizeBytes)
      return reply.code(201).send(asset)
    } catch (error) {
      upload.file.resume()
      if (reservation) {
        try {
          await cleanupUpload(media, storage, reservation)
        } catch (cleanupError) {
          request.log.error({ err: cleanupError, relativePath }, 'Failed to clean up media after upload failure')
        }
        if (error instanceof DomainError && error.code === 'quota_exceeded') {
          return reply.code(413).send({ error: 'The cloud song library has reached its storage limit' })
        }
      }
      if (upload.file.truncated || (error as Error).message === 'Audio file exceeds the 50 MB limit') {
        return reply.code(413).send({ error: 'Audio file exceeds the 50 MB limit' })
      }
      request.log.error({ err: error }, 'Media upload failed')
      return reply.code(500).send({ error: 'Could not store the media file' })
    }
  })

  app.get<{ Params: MediaParams }>('/api/media/:id/stream', async (request, reply) => {
    const asset = await media.get(request.params.id)
    if (!asset) return reply.code(404).send({ error: 'Media asset not found' })
    if (authorizeStream) {
      try {
        if (!await authorizeStream(request, asset)) return reply.code(403).send({ error: 'Media access denied' })
      } catch (error) {
        request.log.error({ err: error }, 'Media authorization failed')
        return reply.code(500).send({ error: 'Could not check media access' })
      }
    }

    let stats: { sizeBytes: number } | undefined
    try {
      stats = await storage.stat(asset.relativePath)
    } catch (error) {
      if (/Invalid media path|outside the configured content directory/.test((error as Error).message)) {
        return reply.code(400).send({ error: 'Invalid media path' })
      }
      request.log.error({ err: error }, 'Media storage lookup failed')
      return reply.code(500).send({ error: 'Could not read the media file' })
    }
    if (!stats) return reply.code(404).send({ error: 'Media file not found' })
    const size = stats.sizeBytes

    const range = request.headers.range
    const sendAudio = async (bounds?: { start: number; end: number }) => {
      try {
        return reply.send(await storage.read(asset.relativePath, bounds))
      } catch (error) {
        request.log.error({ err: error }, 'Media storage read failed')
        reply.removeHeader('Content-Length')
        reply.removeHeader('Content-Range')
        return reply.code(500).type('application/json').send({ error: 'Could not read the media file' })
      }
    }
    reply
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, max-age=3600')
      .header('Content-Type', asset.mimeType)
    if (!range) {
      reply.header('Content-Length', size)
      return sendAudio()
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) return reply.code(416).header('Content-Range', `bytes */${size}`).send()

    const suffix = !match[1]
    const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1])
    const end = suffix || !match[2] ? size - 1 : Math.min(Number(match[2]), size - 1)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size ||
      (suffix && Number(match[2]) === 0) || (match[2] && !Number.isSafeInteger(Number(match[2])))) {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send()
    }

    reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${size}`)
      .header('Content-Length', end - start + 1)
    return sendAudio({ start, end })
  })

  app.delete<{ Params: MediaParams }>('/api/media/:id', async (request, reply) => {
    let ticket
    try {
      ticket = await media.beginDelete(request.params.id, createId())
      if (!ticket) return reply.code(404).send({ error: 'Media asset not found' })
      await deleteMediaObject(storage, ticket.asset.relativePath)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'media_referenced') {
        return reply.code(409).send({ error: 'This song is still referenced by a pack or saved room' })
      }
      request.log.error({ err: error, mediaId: request.params.id }, 'Failed to delete media storage object')
      if (/Invalid media path|outside the configured content directory/.test((error as Error).message)) {
        return reply.code(400).send({ error: 'Invalid media path' })
      }
      return reply.code(500).send({ error: 'Could not remove the media file' })
    }
    // Storage and the database cannot commit atomically. Keep a retryable record if DB deletion fails.
    try {
      await media.finishDelete(ticket, true)
    } catch (error) {
      request.log.error({ err: error, mediaId: request.params.id }, 'Media storage deleted but database removal failed')
      return reply.code(500).send({ error: 'Could not finish removing the media file' })
    }
    return reply.code(204).send()
  })
}
