import fs from 'node:fs'
import path from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'

import { MAX_AUDIO_BYTES } from '../content.js'
import { MAX_BUNDLE_BYTES, runBundleWorker } from './bundleWorker.js'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

async function fixture(bundle: Uint8Array) {
  const directory = await fs.promises.mkdtemp(path.join(process.cwd(), '.test-worker-'))
  directories.push(directory)
  const input = path.join(directory, 'bundle.zip')
  await fs.promises.writeFile(input, bundle)
  return { operation: 'unzip' as const, input, directory }
}

describe('bounded bundle worker', () => {
  it('spools ZIP entries without moving expanded buffers to the main event loop', async () => {
    const job = await fixture(zipSync({
      'pack.json': strToU8('{}'),
      'songs/song.mp3': strToU8('audio-data'),
    }))
    let mainThreadTick = false
    setImmediate(() => { mainThreadTick = true })
    const result = await runBundleWorker(job)
    expect(mainThreadTick).toBe(true)
    expect(result.files.map((file) => [file.name, file.sizeBytes])).toEqual([
      ['pack.json', 2], ['songs/song.mp3', 10],
    ])
    expect(await fs.promises.readFile(result.files[1]!.path, 'utf8')).toBe('audio-data')
  })

  it('rejects oversized declared entries before expanding them', async () => {
    const archive = Buffer.from(zipSync({ 'songs/song.mp3': strToU8('small') }, { level: 0 }))
    archive.writeUInt32LE(MAX_AUDIO_BYTES + 1, 22)
    await expect(runBundleWorker(await fixture(archive))).rejects.toThrow('expanded size limit')

    const files = Object.fromEntries(Array.from({ length: 21 }, (_, index) =>
      [`songs/song${index}.mp3`, strToU8('small')]))
    const aggregate = Buffer.from(zipSync(files, { level: 0 }))
    for (let offset = 0; offset < aggregate.length - 30; offset++) {
      if (aggregate.readUInt32LE(offset) === 0x04034b50) {
        aggregate.writeUInt32LE(MAX_AUDIO_BYTES, offset + 22)
      }
    }
    await expect(runBundleWorker(await fixture(aggregate))).rejects.toThrow()
  })

  it('rejects traversal, duplicate entries, truncated input and oversized compressed spools', async () => {
    await expect(runBundleWorker(await fixture(zipSync({ '../outside.mp3': strToU8('audio') }))))
      .rejects.toThrow('invalid file paths')
    const duplicate = Buffer.from(zipSync({
      'songs/a.mp3': strToU8('a'), 'songs/b.mp3': strToU8('b'),
    }))
    const renamed = Buffer.from(duplicate.toString('latin1').replaceAll('songs/b.mp3', 'songs/a.mp3'), 'latin1')
    await expect(runBundleWorker(await fixture(renamed))).rejects.toThrow('duplicate')
    const truncated = Buffer.from(zipSync({ 'songs/song.mp3': strToU8('audio-data') }, { level: 0 }))
    await expect(runBundleWorker(await fixture(truncated.subarray(0, 45)))).rejects.toThrow()
    const job = await fixture(new Uint8Array())
    await fs.promises.truncate(job.input, MAX_BUNDLE_BYTES + 1)
    await expect(runBundleWorker(job)).rejects.toThrow('500 MB')
  })

  it('admits at most one worker at a time', async () => {
    const job = await fixture(zipSync({ 'pack.json': strToU8('{}') }))
    const active = runBundleWorker(job)
    await expect(runBundleWorker(job)).rejects.toThrow('Another bundle')
    await active
  })
})
