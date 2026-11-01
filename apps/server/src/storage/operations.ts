import { Readable } from 'node:stream'

import { DomainError, type MediaCleanup, type MediaOwner, type UploadReservation } from '../domain.js'
import { MAX_AUDIO_BYTES } from '../content.js'
import { createId } from '../ids.js'
import type { MediaRepository } from '../repositories/media.js'
import type { MediaStorage } from './media.js'

export async function deleteMediaObject(storage: MediaStorage, key: string): Promise<void> {
  await storage.delete(key)
  if (await storage.stat(key)) throw new Error('Media storage object still exists after deletion')
}

export async function releaseMediaClaims(media: MediaRepository, owner: MediaOwner): Promise<void> {
  while (!(await media.releaseClaims(owner, { limit: 100 })).done) { /* Release bounded pages. */ }
}

export async function writeReservedMedia(
  media: MediaRepository,
  storage: MediaStorage,
  reservation: UploadReservation,
  key: string,
  source: Readable,
  mimeType: string,
): Promise<{ reservation: UploadReservation; sizeBytes: number }> {
  if (reservation.ownedKeys.length !== 1 || reservation.ownedKeys[0] !== key) {
    throw new Error('Upload must own exactly this media key')
  }
  let current = reservation
  let sizeBytes = 0
  const guarded = Readable.from((async function* () {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
      const nextSize = sizeBytes + chunk.length
      if (nextSize > MAX_AUDIO_BYTES) throw new Error('Audio file exceeds the 50 MB limit')
      if (nextSize > current.reservedBytes) current = await media.growReservation(current, nextSize)
      sizeBytes = nextSize
      yield chunk
    }
  })())
  try {
    const storedBytes = await storage.write(key, guarded, mimeType)
    if (storedBytes !== sizeBytes) throw new Error('Stored audio size does not match the reserved upload')
    return { reservation: current, sizeBytes }
  } finally {
    guarded.destroy()
    source.destroy()
  }
}

export async function cleanupUpload(
  media: MediaRepository,
  storage: MediaStorage,
  reservation: UploadReservation,
): Promise<void> {
  const absent: string[] = []
  for (const key of reservation.ownedKeys) {
    // A lost metadata response may already have committed this operation's asset.
    const asset = await media.findByPath(key)
    if (asset) {
      const ticket = await media.beginDelete(asset.id, createId())
      if (!ticket) throw new Error('Media cleanup could not acquire deletion ownership')
      await deleteMediaObject(storage, key)
      await media.finishDelete(ticket, true)
    } else {
      await deleteMediaObject(storage, key)
      absent.push(key)
    }
  }
  // Committed keys no longer belong to the upload reservation.
  if (absent.length) await media.abortUpload(reservation, absent)
}

export async function recoverMediaOperations(media: MediaRepository, storage: MediaStorage): Promise<void> {
  const pending: MediaCleanup[] = []
  let cursor: string | undefined
  do {
    const page = await media.pendingCleanup({ limit: 100, ...(cursor ? { cursor } : {}) })
    pending.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  // Operation holds must be released before their upload/deletion tickets can proceed.
  pending.sort((left, right) => Number(right.kind === 'operation') - Number(left.kind === 'operation'))
  for (const operation of pending) {
    if (operation.kind === 'operation') {
      await releaseMediaClaims(media, operation.owner)
      if (operation.published) continue
      for (const key of operation.ownedKeys) {
        const asset = await media.findByPath(key)
        if (!asset) {
          await deleteMediaObject(storage, key)
          continue
        }
        try {
          const ticket = await media.beginDelete(asset.id, createId())
          if (!ticket) throw new Error('Media cleanup could not acquire deletion ownership')
          await deleteMediaObject(storage, key)
          await media.finishDelete(ticket, true)
        } catch (error) {
          // A published pack or room now owns this song; recovery must preserve it.
          if (!(error instanceof DomainError && error.code === 'media_referenced')) throw error
        }
      }
      await media.completeOperation(operation.owner)
    } else if (operation.kind === 'upload') {
      await cleanupUpload(media, storage, operation.reservation)
    } else {
      await deleteMediaObject(storage, operation.ticket.asset.relativePath)
      await media.finishDelete(operation.ticket, true)
    }
  }
}
