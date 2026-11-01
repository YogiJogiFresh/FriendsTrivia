import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { AzureCliCredential } from '@azure/identity'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it } from 'vitest'

import { AzureBlobMediaStorage } from '../storage/azureMedia.js'
import { validateBlobTestTarget } from './blobTestTarget.js'

const enabled = process.env.FRIENDS_TRIVIA_BLOB_LIVE === 'approved-isolated-target'

describe('LIVE Blob SDK acceptance — separately approved isolated container only', () => {
  it.skipIf(!enabled)('round-trips private media and cleans only confirmed run-owned data', async () => {
    const target = validateBlobTestTarget(process.env)
    const client = new BlobServiceClient(target.endpoint, new AzureCliCredential(), {
      retryOptions: { maxTries: 2, tryTimeoutInMs: 10_000 },
    })
    const container = client.getContainerClient(target.container)
    expect((await container.getProperties()).blobPublicAccess).toBeUndefined()
    const nonce = randomUUID()
    const name = `test-${target.runId}-${nonce}.mp3`
    const key = `songs/${name}`
    const blob = container.getBlockBlobClient(name)
    const fence = container.getBlockBlobClient(`test-run-${target.runId}.json`)
    const storage = new AzureBlobMediaStorage(container, target.container)
    const payload = Buffer.from('FriendsTrivia isolated Blob fixture\n')
    let ownedRun = false
    let ownedBlob = false
    let etag: string | undefined
    let passed = false
    let cleaned = false
    try {
      await fence.uploadData(Buffer.from(JSON.stringify({ runId: target.runId, nonce, name, status: 'running' })), {
        conditions: { ifNoneMatch: '*' }, metadata: { testrunid: target.runId, nonce },
      })
      ownedRun = true
      expect(await storage.stat(key)).toBeUndefined()
      expect(await storage.write(key, Readable.from(payload), 'audio/mpeg')).toBe(payload.length)
      ownedBlob = true
      const properties = await blob.getProperties()
      etag = properties.etag
      if (!etag) throw new Error('Missing ETag for run-owned Blob')
      expect(properties.contentType).toBe('audio/mpeg')
      expect(await storage.stat(key)).toEqual({ sizeBytes: payload.length })
      const read = async (range?: { start: number; end: number }) => {
        const chunks: Uint8Array[] = []
        for await (const chunk of await storage.read(key, range)) {
          if (!(chunk instanceof Uint8Array)) throw new Error('Unexpected Blob stream chunk')
          chunks.push(chunk)
        }
        return Buffer.concat(chunks)
      }
      expect(await read()).toEqual(payload)
      expect(await read({ start: 7, end: 13 })).toEqual(payload.subarray(7, 14))
      await expect(storage.write(key, Readable.from('replacement'), 'audio/mpeg'))
        .rejects.toMatchObject({ statusCode: 409, code: 'BlobAlreadyExists' })
      expect(await read()).toEqual(payload)
      await blob.deleteIfExists({ conditions: { ifMatch: etag } })
      expect(await storage.stat(key)).toBeUndefined()
      passed = true
    } finally {
      if (ownedRun) {
        try {
          if (await blob.exists()) {
            if (!ownedBlob || !etag) {
              throw new Error(`Unconfirmed test upload requires manual inspection: ${name}`)
            }
            await blob.deleteIfExists({ conditions: { ifMatch: etag } })
            if (await blob.exists()) throw new Error('Run-owned Blob cleanup did not finish')
          }
          cleaned = true
        } finally {
          const marker = await fence.getProperties()
          if (marker.metadata?.testrunid !== target.runId || marker.metadata?.nonce !== nonce || !marker.etag) {
            throw new Error('Refusing to update an unowned Blob run fence')
          }
          await fence.uploadData(Buffer.from(JSON.stringify({
            runId: target.runId, nonce, name, status: passed && cleaned ? 'completed' : 'failed',
          })), { conditions: { ifMatch: marker.etag }, metadata: { testrunid: target.runId, nonce } })
        }
      }
    }
  }, 120_000)
})
