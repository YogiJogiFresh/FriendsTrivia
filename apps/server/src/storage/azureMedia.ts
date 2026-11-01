import type { ContainerClient } from '@azure/storage-blob'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { audioSizeLimiter, type MediaRange, type MediaStorage } from './media.js'

function blobKey(key: string): string {
  const normalized = key.replaceAll('\\', '/')
  if (!/^songs\/[A-Za-z0-9._-]+$/.test(normalized) || normalized.endsWith('/..')) {
    throw new Error('Invalid media path')
  }
  return normalized.slice('songs/'.length)
}

export class AzureBlobMediaStorage implements MediaStorage {
  readonly info: MediaStorage['info']

  constructor(private readonly container: ContainerClient, containerName = 'songs') {
    this.info = { kind: 'azure-blob', container: containerName }
  }

  async write(key: string, source: Readable, mimeType: string): Promise<number> {
    const client = this.container.getBlockBlobClient(blobKey(key))
    const limited = audioSizeLimiter()
    let size = 0
    limited.on('data', (chunk: Buffer) => { size += chunk.length })
    const controller = new AbortController()
    const transfer = client.uploadStream(limited, 1024 * 1024, 2, {
      blobHTTPHeaders: { blobContentType: mimeType },
      conditions: { ifNoneMatch: '*' },
      abortSignal: controller.signal,
    })
    try {
      await Promise.all([pipeline(source, limited), transfer])
      return size
    } catch (error) {
      controller.abort()
      source.destroy()
      limited.destroy()
      await transfer.catch(() => undefined)
      // A lost upload response can mean the block list committed; keys are generated uniquely by callers.
      if (![409, 412].includes((error as { statusCode?: number }).statusCode ?? 0)) {
        try { await client.deleteIfExists() } catch (cleanupError) {
          console.error('Failed to clean up incomplete Blob upload', cleanupError)
        }
      }
      throw error
    }
  }

  async stat(key: string): Promise<{ sizeBytes: number } | undefined> {
    try {
      const properties = await this.container.getBlobClient(blobKey(key)).getProperties()
      if (properties.contentLength === undefined) throw new Error('Blob size is unavailable')
      return { sizeBytes: properties.contentLength }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return undefined
      throw error
    }
  }

  async read(key: string, range?: MediaRange): Promise<Readable> {
    const response = await this.container.getBlobClient(blobKey(key))
      .download(range?.start ?? 0, range ? range.end - range.start + 1 : undefined)
    if (!response.readableStreamBody) throw new Error('Blob download returned no stream')
    return response.readableStreamBody as Readable
  }

  async delete(key: string): Promise<void> {
    await this.container.getBlobClient(blobKey(key)).deleteIfExists()
  }
}
