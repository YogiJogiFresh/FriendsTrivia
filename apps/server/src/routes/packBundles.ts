import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { FastifyInstance } from 'fastify'

import { MAX_AUDIO_BYTES, audioExtension } from '../content.js'
import { createId } from '../ids.js'
import { DomainError, type UploadReservation } from '../domain.js'
import type { MediaRepository } from '../repositories/media.js'
import type { PackRepository } from '../repositories/packs.js'
import { FilesystemMediaStorage, type MediaStorage } from '../storage/media.js'
import { cleanupUpload, releaseMediaClaims, writeReservedMedia } from '../storage/operations.js'
import {
  MAX_BUNDLE_BYTES,
  MAX_EXPANDED_BUNDLE_BYTES,
  MAX_MANIFEST_BYTES,
  runBundleWorker,
  type BundleFile,
} from '../storage/bundleWorker.js'
import { isPackInput } from './packs.js'

interface BundleMedia {
  sourceId: string
  fileName: string
  originalName: string
  mimeType: string
}

interface PackWithMedia {
  title: string
  description?: string
  status?: 'draft' | 'ready' | 'archived'
  defaultSettings?: unknown
  categories: Array<{
    title: string
    clues: Array<{
      type: string
      boardValue: number
      prompt: string
      timerSeconds?: number
      mediaAssetId?: string | null
      revealMediaAssetId?: string | null
      finalQuestion?: boolean
      config: unknown
    }>
  }>
}

interface BundlePack {
  schemaVersion: 2
  pack: PackWithMedia
  media: BundleMedia[]
}

interface PackBundleOptions {
  optimized?: boolean
  storage?: MediaStorage
}

interface CleanupLogger {
  error(object: unknown, message: string): void
}

let bundleInProgress = false

function acquireBundleSlot(): () => void {
  if (bundleInProgress) {
    throw Object.assign(new Error('Another bundle is being processed; try again shortly'), { statusCode: 429 })
  }
  bundleInProgress = true
  return () => { bundleInProgress = false }
}

function referencedMediaIds(pack: PackWithMedia): string[] {
  return [...new Set(pack.categories.flatMap((category) =>
    category.clues.flatMap((clue) => [clue.mediaAssetId, clue.revealMediaAssetId])
      .filter((id): id is string => Boolean(id)),
  ))]
}

function isBundlePack(value: unknown): value is PackWithMedia {
  if (!isPackInput(value) || value.categories.length > 12) return false
  return value.categories.every((category) => category && typeof category.title === 'string' &&
    Array.isArray(category.clues) && category.clues.length <= 20 &&
    category.clues.every((clue) => clue && typeof clue.type === 'string' &&
      typeof clue.prompt === 'string' && typeof clue.boardValue === 'number' &&
      (clue.mediaAssetId == null || typeof clue.mediaAssetId === 'string') &&
      (clue.revealMediaAssetId == null || typeof clue.revealMediaAssetId === 'string')))
}

async function makeSpool(storage: MediaStorage): Promise<string> {
  // App Service scratch is disposable by design; durable songs only go through MediaStorage.
  const root = storage.info.kind === 'filesystem'
    ? path.join(path.dirname(storage.info.directory), '.bundle-spool')
    : path.join(os.tmpdir(), 'friends-trivia-bundles')
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
  return fs.promises.mkdtemp(path.join(root, 'bundle-'))
}

async function cleanupSpool(directory: string, logger: CleanupLogger): Promise<void> {
  try {
    await fs.promises.rm(directory, { recursive: true, force: true })
  } catch (error) {
    logger.error({ err: error }, 'Failed to remove bundle spool directory')
  }
}

async function exportBundleFile(
  pack: PackWithMedia,
  media: MediaRepository,
  storage: MediaStorage,
  directory: string,
  optimized = false,
): Promise<string> {
  const files: BundleFile[] = []
  const manifestMedia: BundleMedia[] = []
  const optimizedFileNames = new Map<string, string>()
  let expanded = 0
  for (const sourceId of referencedMediaIds(pack)) {
    const asset = await media.get(sourceId)
    if (!asset) throw new Error(`Referenced media asset ${sourceId} was not found`)
    let metadata
    try {
      metadata = await storage.stat(asset.relativePath)
    } catch {
      throw new Error('Could not read the media file')
    }
    if (!metadata) throw new Error(`Song "${asset.originalName}" was not found`)
    if (metadata.sizeBytes > MAX_AUDIO_BYTES) throw new Error(`Song "${asset.originalName}" exceeds the 50 MB limit`)
    const target = path.join(directory, `song-${manifestMedia.length}`)
    const hash = createHash('sha256')
    let sizeBytes = 0
    const check = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length
        expanded += chunk.length
        if (optimized) hash.update(chunk)
        callback(sizeBytes > MAX_AUDIO_BYTES || expanded > MAX_EXPANDED_BUNDLE_BYTES
          ? new Error('Bundle exceeds its expanded size limit') : null, chunk)
      },
    })
    try {
      await pipeline(await storage.read(asset.relativePath), check, fs.createWriteStream(target, { flags: 'wx' }))
    } catch {
      throw new Error('Could not read the media file or the bundle exceeds its expanded size limit')
    }
    const digest = optimized ? hash.digest('hex') : undefined
    const extension = audioExtension(asset.mimeType)
    if (!extension) throw new Error(`Song "${asset.originalName}" is unsupported`)
    const fileName = (digest && optimizedFileNames.get(digest)) ||
      `songs/${digest ?? sourceId}${extension}`
    if (!files.some((file) => file.name === fileName)) {
      files.push({ name: fileName, path: target, sizeBytes })
    }
    if (digest) optimizedFileNames.set(digest, fileName)
    manifestMedia.push({ sourceId, fileName, originalName: asset.originalName, mimeType: asset.mimeType })
  }
  const manifest = JSON.stringify({ schemaVersion: 2, pack, media: manifestMedia }, null, 2)
  const manifestSize = Buffer.byteLength(manifest)
  if (manifestSize > MAX_MANIFEST_BYTES || expanded + manifestSize > MAX_EXPANDED_BUNDLE_BYTES) {
    throw new Error('Bundle manifest or expanded size exceeds its limit')
  }
  const manifestPath = path.join(directory, 'pack.json')
  await fs.promises.writeFile(manifestPath, manifest, { flag: 'wx' })
  files.push({ name: 'pack.json', path: manifestPath, sizeBytes: manifestSize })
  const output = path.join(directory, 'export.friendstrivia')
  await runBundleWorker({ operation: 'zip', input: output, directory, files, optimized })
  return output
}

export async function createPackBundle(
  pack: PackWithMedia,
  media: MediaRepository,
  contentRoot: string,
  options: PackBundleOptions = {},
): Promise<Uint8Array> {
  const release = acquireBundleSlot()
  const storage = options.storage ?? new FilesystemMediaStorage(contentRoot)
  let directory: string | undefined
  try {
    directory = await makeSpool(storage)
    const output = await exportBundleFile(pack, media, storage, directory, options.optimized)
    // Compatibility helper for callers already holding a bundle; HTTP export streams the spool.
    return await fs.promises.readFile(output)
  } finally {
    if (directory) await cleanupSpool(directory, console)
    release()
  }
}

async function importBundleFile(
  input: string,
  directory: string,
  packs: PackRepository,
  media: MediaRepository,
  storage: MediaStorage,
  logger: CleanupLogger,
): Promise<unknown> {
  const { files } = await runBundleWorker({ operation: 'unzip', input, directory })
  const manifestFile = files.find((file) => file.name === 'pack.json')
  if (!manifestFile) throw new Error('Bundle is missing a valid pack.json manifest')
  const manifest = JSON.parse(await fs.promises.readFile(manifestFile.path, 'utf8')) as Partial<BundlePack>
  if (manifest.schemaVersion !== 2 || !isBundlePack(manifest.pack) || !Array.isArray(manifest.media)) {
    throw new Error('Invalid or unsupported pack bundle')
  }
  const referencedIds = referencedMediaIds(manifest.pack)
  const bundledIds = new Set<string>()
  for (const entry of manifest.media) {
    if (!entry || typeof entry.sourceId !== 'string' || !entry.sourceId ||
      bundledIds.has(entry.sourceId) || typeof entry.fileName !== 'string' ||
      !/^songs\/[A-Za-z0-9._-]+$/.test(entry.fileName) ||
      typeof entry.originalName !== 'string' || typeof entry.mimeType !== 'string' ||
      !audioExtension(entry.mimeType) || !files.some((file) => file.name === entry.fileName)) {
      throw new Error('Bundle contains duplicate, missing or invalid media references')
    }
    bundledIds.add(entry.sourceId)
  }
  if (referencedIds.some((id) => !bundledIds.has(id))) throw new Error('Bundle is missing media referenced by the pack')
  // Each manifest reference may expand a deduplicated song into a new storage object.
  if (manifest.media.reduce((total, entry) =>
    total + (files.find((file) => file.name === entry.fileName)?.sizeBytes ?? 0), 0) > MAX_EXPANDED_BUNDLE_BYTES) {
    throw new Error('Bundle exceeds its expanded size limit')
  }
  const uploads: Array<{ entry: BundleMedia; file: BundleFile; key: string; reservation: UploadReservation }> = []
  const owner = { kind: 'operation' as const, id: createId() }
  let createdPackId: string | undefined
  try {
    // Hold the entire expanded import quota before writing any durable song.
    for (const entry of manifest.media) {
      const file = files.find((candidate) => candidate.name === entry.fileName)!
      if (file.sizeBytes > MAX_AUDIO_BYTES) throw new Error('Audio file exceeds the 50 MB limit')
      const key = path.join('songs', `${createId()}${audioExtension(entry.mimeType)!}`)
      const reservation = await media.reserveUpload(createId(), [key])
      const upload = { entry, file, key, reservation }
      uploads.push(upload)
      upload.reservation = await media.growReservation(reservation, file.sizeBytes)
    }
    const mediaIdMap = new Map<string, string>()
    for (const upload of uploads) {
      const { entry, file, key } = upload
      const written = await writeReservedMedia(media, storage, upload.reservation, key, fs.createReadStream(file.path), entry.mimeType)
      upload.reservation = written.reservation
      const asset = await media.commitUploaded(upload.reservation, {
        relativePath: key,
        originalName: path.basename(entry.originalName.replaceAll('\\', '/')),
        mimeType: entry.mimeType,
        sizeBytes: written.sizeBytes,
      }, written.sizeBytes, owner)
      mediaIdMap.set(entry.sourceId, asset.id)
    }
    const pack = manifest.pack
    const created = await packs.create({
      title: pack.title.trim(),
      ...(pack.description ? { description: pack.description } : {}),
    }) as { id: string }
    createdPackId = created.id
    const result = await packs.replace(created.id, {
      title: pack.title,
      ...(pack.description ? { description: pack.description } : {}),
      status: pack.status ?? 'draft',
      defaultSettings: pack.defaultSettings,
      categories: pack.categories.map((category) => ({
        title: category.title,
        clues: category.clues.map((clue) => ({
          type: clue.type,
          boardValue: clue.boardValue,
          prompt: clue.prompt,
          ...(clue.timerSeconds === undefined ? {} : { timerSeconds: clue.timerSeconds }),
          mediaAssetId: clue.mediaAssetId ? mediaIdMap.get(clue.mediaAssetId)! : null,
          revealMediaAssetId: clue.revealMediaAssetId ? mediaIdMap.get(clue.revealMediaAssetId)! : null,
          finalQuestion: Boolean(clue.finalQuestion),
          config: clue.config,
        })),
      })),
    }, owner)
    if (!result) throw new Error('Imported pack could not be saved')
    // Publication already owns the references; a failed release must not roll it back.
    try {
      await media.completeOperation(owner)
      await releaseMediaClaims(media, owner)
    } catch (error) {
      logger.error({ err: error, owner }, 'Failed to release published import media claims')
    }
    return result
  } catch (error) {
    const cleanup = async (operation: () => Promise<unknown>, message: string): Promise<boolean> => {
      try { await operation(); return true } catch (cleanupError) {
        logger.error({ err: cleanupError }, message)
        return false
      }
    }
    const packRemoved = !createdPackId || await cleanup(async () => packs.remove(createdPackId!), 'Failed to remove partially imported pack')
    const claimsReleased = packRemoved && await cleanup(
      async () => releaseMediaClaims(media, owner), 'Failed to release failed import media claims',
    )
    if (claimsReleased) {
      let cleaned = true
      for (const upload of uploads) {
        const removed = await cleanup(async () => cleanupUpload(media, storage, upload.reservation), 'Failed to remove imported media storage object')
        cleaned = removed && cleaned
      }
      if (cleaned) await cleanup(async () => media.completeOperation(owner), 'Failed to finish failed import media claim cleanup')
    }
    throw error
  }
}

export async function importPackBundle(
  bundle: Uint8Array,
  packs: PackRepository,
  media: MediaRepository,
  contentRoot: string,
  storage: MediaStorage = new FilesystemMediaStorage(contentRoot),
  logger: CleanupLogger = console,
): Promise<unknown> {
  if (bundle.byteLength > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds the 500 MB limit')
  const release = acquireBundleSlot()
  let directory: string | undefined
  try {
    directory = await makeSpool(storage)
    const input = path.join(directory, 'import.friendstrivia')
    await fs.promises.writeFile(input, bundle, { flag: 'wx' })
    return await importBundleFile(input, directory, packs, media, storage, logger)
  } finally {
    if (directory) await cleanupSpool(directory, logger)
    release()
  }
}

export async function registerPackBundleRoutes(
  app: FastifyInstance,
  packs: PackRepository,
  media: MediaRepository,
  contentRoot: string,
  storage: MediaStorage = new FilesystemMediaStorage(contentRoot),
): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { optimized?: string } }>(
    '/api/packs/:id/export-bundle',
    async (request, reply) => {
      const pack = await packs.get(request.params.id) as PackWithMedia | undefined
      if (!pack) return reply.code(404).send({ error: 'Pack not found' })
      let directory: string | undefined
      let release: (() => void) | undefined
      try {
        release = acquireBundleSlot()
        directory = await makeSpool(storage)
        const output = await exportBundleFile(pack, media, storage, directory, request.query.optimized === 'true')
        const safeTitle = pack.title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'pack'
        const stream = fs.createReadStream(output)
        const spool = directory
        const free = release
        stream.once('close', () => {
          void cleanupSpool(spool, request.log).finally(free)
        })
        return reply.type('application/zip')
          .header('Content-Length', (await fs.promises.stat(output)).size)
          .header('Content-Disposition', `attachment; filename="${safeTitle}.friendstrivia"`)
          .send(stream)
      } catch (error) {
        if (directory) await cleanupSpool(directory, request.log)
        release?.()
        return reply.code((error as { statusCode?: number }).statusCode === 429 ? 429 : 400)
          .send({ error: error instanceof Error ? error.message : 'Could not export pack' })
      }
    },
  )
  app.post('/api/packs/import-bundle', async (request, reply) => {
    let directory: string | undefined
    let release: (() => void) | undefined
    try {
      release = acquireBundleSlot()
      const upload = await request.file({ limits: { files: 1, fileSize: MAX_BUNDLE_BYTES } })
      if (!upload) {
        reply.code(400)
        return { error: 'A pack bundle is required' }
      }
      if (!upload.filename.toLowerCase().endsWith('.friendstrivia')) {
        upload.file.resume()
        reply.code(400)
        return { error: 'Pack imports must use a .friendstrivia bundle' }
      }
      directory = await makeSpool(storage)
      const input = path.join(directory, 'import.friendstrivia')
      await pipeline(upload.file, fs.createWriteStream(input, { flags: 'wx' }))
      if (upload.file.truncated) {
        reply.code(413)
        return { error: 'Bundle exceeds the 500 MB limit' }
      }
      const imported = await importBundleFile(input, directory, packs, media, storage, request.log)
      reply.code(201)
      return imported
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status === 429) request.raw.resume()
      const quotaExceeded = error instanceof DomainError && error.code === 'quota_exceeded'
      reply.code(quotaExceeded ? 413 : status === 413 || status === 429 ? status : 400)
      return { error: quotaExceeded ? 'The cloud song library has reached its storage limit'
        : error instanceof DomainError && error.code === 'unavailable' ? 'Media storage is unavailable'
        : error instanceof Error ? error.message : 'Could not import pack bundle' }
    } finally {
      if (directory) await cleanupSpool(directory, request.log)
      release?.()
    }
  })
}
