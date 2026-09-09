import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { FastifyInstance } from 'fastify'

import { MAX_AUDIO_BYTES, audioExtension, resolveContentPath } from '../content.js'
import { createId } from '../ids.js'
import type { MediaRepository } from '../repositories/media.js'
import type { PackRepository } from '../repositories/packs.js'
import { isPackInput } from './packs.js'

const MAX_BUNDLE_BYTES = 500 * 1024 * 1024

interface BundleMedia {
  sourceId: string
  fileName: string
  originalName: string
  mimeType: string
}

interface BundlePack {
  schemaVersion: 2
  pack: ReturnType<PackRepository['get']>
  media: BundleMedia[]
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

interface PackBundleOptions {
  optimized?: boolean
}

function referencedMediaIds(pack: PackWithMedia): string[] {
  const ids = new Set<string>()
  for (const category of pack.categories) {
    for (const clue of category.clues) {
      if (clue.mediaAssetId) ids.add(clue.mediaAssetId)
      if (clue.revealMediaAssetId) ids.add(clue.revealMediaAssetId)
    }
  }
  return [...ids]
}

export function createPackBundle(
  pack: PackWithMedia,
  media: MediaRepository,
  contentRoot: string,
  options: PackBundleOptions = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const manifestMedia: BundleMedia[] = []
  const optimizedFileNames = new Map<string, string>()

  for (const sourceId of referencedMediaIds(pack)) {
    const asset = media.get(sourceId)
    if (!asset) throw new Error(`Referenced media asset ${sourceId} was not found`)
    const absolutePath = resolveContentPath(contentRoot, asset.relativePath)
    const contents = fs.readFileSync(absolutePath)
    if (contents.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(`Song "${asset.originalName}" exceeds the 50 MB limit`)
    }
    const extension = path.extname(asset.relativePath).toLocaleLowerCase()
    const digest = options.optimized
      ? createHash('sha256').update(contents).digest('hex')
      : undefined
    const fileName =
      (digest ? optimizedFileNames.get(digest) : undefined) ??
      `songs/${options.optimized && digest ? digest : sourceId}${extension}`
    if (!files[fileName]) files[fileName] = new Uint8Array(contents)
    if (digest) optimizedFileNames.set(digest, fileName)
    manifestMedia.push({
      sourceId,
      fileName,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
    })
  }

  const manifest: BundlePack = {
    schemaVersion: 2,
    pack,
    media: manifestMedia,
  }
  files['pack.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return zipSync(files, { level: options.optimized ? 6 : 0 })
}

export function importPackBundle(
  bundle: Uint8Array,
  packs: PackRepository,
  media: MediaRepository,
  contentRoot: string,
): unknown {
  const files = unzipSync(bundle)
  const manifestBytes = files['pack.json']
  if (!manifestBytes || manifestBytes.byteLength > 2 * 1024 * 1024) {
    throw new Error('Bundle is missing a valid pack.json manifest')
  }
  const manifest = JSON.parse(strFromU8(manifestBytes)) as Partial<BundlePack>
  if (manifest.schemaVersion !== 2 || !isPackInput(manifest.pack) || !Array.isArray(manifest.media)) {
    throw new Error('Invalid or unsupported pack bundle')
  }
  const referencedIds = referencedMediaIds(manifest.pack)
  const bundledIds = new Set<string>()
  for (const entry of manifest.media) {
    if (!entry || typeof entry.sourceId !== 'string' || bundledIds.has(entry.sourceId)) {
      throw new Error('Bundle contains duplicate or invalid media references')
    }
    bundledIds.add(entry.sourceId)
  }
  if (referencedIds.some((id) => !bundledIds.has(id))) {
    throw new Error('Bundle is missing media referenced by the pack')
  }

  const createdFiles: string[] = []
  const createdMediaIds: string[] = []
  let createdPackId: string | undefined
  try {
    const mediaIdMap = new Map<string, string>()
    for (const entry of manifest.media) {
      if (
        !entry ||
        typeof entry.sourceId !== 'string' ||
        typeof entry.fileName !== 'string' ||
        !/^songs\/[A-Za-z0-9._-]+$/.test(entry.fileName) ||
        typeof entry.originalName !== 'string' ||
        typeof entry.mimeType !== 'string'
      ) {
        throw new Error('Bundle contains invalid media metadata')
      }
      const contents = files[entry.fileName]
      const extension = audioExtension(entry.mimeType)
      if (!contents || !extension || contents.byteLength > MAX_AUDIO_BYTES) {
        throw new Error(`Bundle song "${entry.originalName}" is missing or unsupported`)
      }
      const relativePath = path.join('songs', `${createId()}${extension}`)
      const absolutePath = resolveContentPath(contentRoot, relativePath)
      fs.writeFileSync(absolutePath, contents, { flag: 'wx' })
      createdFiles.push(absolutePath)
      const asset = media.create({
        relativePath,
        originalName: path.basename(entry.originalName),
        mimeType: entry.mimeType,
        sizeBytes: contents.byteLength,
      })
      createdMediaIds.push(asset.id)
      mediaIdMap.set(entry.sourceId, asset.id)
    }

    const pack = manifest.pack
    const created = packs.create({
      title: pack.title.trim(),
      ...(pack.description ? { description: pack.description } : {}),
    }) as { id: string }
    createdPackId = created.id
    return packs.replace(created.id, {
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
          mediaAssetId: clue.mediaAssetId ? (mediaIdMap.get(clue.mediaAssetId) ?? null) : null,
          revealMediaAssetId: clue.revealMediaAssetId
            ? (mediaIdMap.get(clue.revealMediaAssetId) ?? null)
            : null,
          finalQuestion: Boolean(clue.finalQuestion),
          config: clue.config,
        })),
      })),
    })
  } catch (error) {
    if (createdPackId) packs.remove(createdPackId)
    createdMediaIds.forEach((id) => media.remove(id))
    createdFiles.forEach((file) => fs.rmSync(file, { force: true }))
    throw error
  }
}

export async function registerPackBundleRoutes(
  app: FastifyInstance,
  packs: PackRepository,
  media: MediaRepository,
  contentRoot: string,
): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { optimized?: string } }>(
    '/api/packs/:id/export-bundle',
    async (request, reply) => {
    const pack = packs.get(request.params.id) as PackWithMedia | undefined
    if (!pack) return reply.code(404).send({ error: 'Pack not found' })
    try {
      const bundle = createPackBundle(pack, media, contentRoot, {
        optimized: request.query.optimized === 'true',
      })
      const safeTitle = pack.title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'pack'
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="${safeTitle}.friendstrivia"`)
        .send(Buffer.from(bundle))
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Could not export pack' })
    }
  },
  )

  app.post('/api/packs/import-bundle', async (request, reply) => {
    try {
      const upload = await request.file({ limits: { files: 1, fileSize: MAX_BUNDLE_BYTES } })
      if (!upload) return reply.code(400).send({ error: 'A pack bundle is required' })
      if (!upload.filename.toLocaleLowerCase().endsWith('.friendstrivia')) {
        upload.file.resume()
        return reply.code(400).send({ error: 'Pack imports must use a .friendstrivia bundle' })
      }
      const contents = await upload.toBuffer()
      return reply.code(201).send(importPackBundle(contents, packs, media, contentRoot))
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Could not import pack bundle' })
    }
  })
}
