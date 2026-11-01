import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { MAX_AUDIO_BYTES, resolveContentPath } from '../content.js'

export interface MediaRange {
  start: number
  end: number
}

export interface MediaStorage {
  readonly info: { kind: 'filesystem'; directory: string } | { kind: 'azure-blob'; container: string }
  write(key: string, source: Readable, mimeType: string): Promise<number>
  stat(key: string): Promise<{ sizeBytes: number } | undefined>
  read(key: string, range?: MediaRange): Promise<Readable>
  delete(key: string): Promise<void>
}

export function audioSizeLimiter(): Transform {
  let size = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      callback(size > MAX_AUDIO_BYTES ? new Error('Audio file exceeds the 50 MB limit') : null, chunk)
    },
  })
}

export class FilesystemMediaStorage implements MediaStorage {
  readonly info: MediaStorage['info']

  constructor(private readonly contentRoot: string) {
    this.info = { kind: 'filesystem', directory: resolveContentPath(contentRoot, 'songs') }
  }

  async write(key: string, source: Readable, _mimeType: string): Promise<number> {
    const file = resolveContentPath(this.contentRoot, key)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const output = fs.createWriteStream(file, { flags: 'wx' })
    let created = false
    output.once('open', () => { created = true })
    try {
      await pipeline(source, audioSizeLimiter(), output)
    } catch (error) {
      if (created) {
        try { await this.delete(key) } catch (cleanupError) {
          console.error('Failed to clean up incomplete media file', cleanupError)
        }
      }
      throw error
    }
    return (await fs.promises.stat(file)).size
  }

  async stat(key: string): Promise<{ sizeBytes: number } | undefined> {
    try {
      const stats = await fs.promises.stat(resolveContentPath(this.contentRoot, key))
      return stats.isFile() ? { sizeBytes: stats.size } : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async read(key: string, range?: MediaRange): Promise<Readable> {
    return fs.createReadStream(resolveContentPath(this.contentRoot, key), range)
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.promises.unlink(resolveContentPath(this.contentRoot, key))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export async function createMediaStorage(options: {
  mode?: 'local' | 'cloud'
  contentRoot: string
  azureStorageAccountUrl?: string
  azureStorageContainer?: string
  azureClientId?: string
}): Promise<MediaStorage> {
  if (options.mode !== undefined && options.mode !== 'local' && options.mode !== 'cloud') {
    throw new Error('FRIENDS_TRIVIA_MODE must be local or cloud')
  }
  if (options.mode !== 'cloud') return new FilesystemMediaStorage(options.contentRoot)
  if (!options.azureStorageAccountUrl) throw new Error('AZURE_STORAGE_ACCOUNT_URL is required in cloud mode')
  const url = new URL(options.azureStorageAccountUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Azure storage requires an HTTPS account URL without credentials')
  }
  const [{ BlobServiceClient }, { ManagedIdentityCredential }, { AzureBlobMediaStorage }] =
    await Promise.all([
      import('@azure/storage-blob'),
      import('@azure/identity'),
      import('./azureMedia.js'),
    ])
  const credential = options.azureClientId
    ? new ManagedIdentityCredential({ clientId: options.azureClientId })
    : new ManagedIdentityCredential()
  const containerName = options.azureStorageContainer ?? 'songs'
  const container = new BlobServiceClient(url.toString(), credential)
    .getContainerClient(containerName)
  // Provisioning owns container creation; startup refuses anonymous access or unavailable storage.
  const properties = await container.getProperties()
  if (properties.blobPublicAccess) throw new Error('The songs container must be private')
  return new AzureBlobMediaStorage(container, containerName)
}
