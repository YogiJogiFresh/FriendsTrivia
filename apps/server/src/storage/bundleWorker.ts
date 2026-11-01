import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

export const MAX_BUNDLE_BYTES = 500 * 1024 * 1024
export const MAX_EXPANDED_BUNDLE_BYTES = 1024 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024

export interface BundleFile {
  name: string
  path: string
  sizeBytes: number
}

// fflate's synchronous codec runs only in this worker; files never cross its message channel.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } = require(workerData.codecPath)
const { operation, input, directory, files, optimized, limits } = workerData
const buffer = Buffer.alloc(8192)
let inputFd
let outputFd
let openFiles = new Set()
try {
  if (operation === 'unzip') {
    if (fs.statSync(input).size > limits.compressed) throw new Error('Bundle exceeds the 500 MB limit')
    let expanded = 0
    let count = 0
    let completed = 0
    let declared = 0
    const result = []
    const names = new Set()
    const unzip = new Unzip(file => {
      if (++count > 1000 || names.has(file.name)) throw new Error('Bundle contains duplicate or excessive entries')
      names.add(file.name)
      const maximum = file.name === 'pack.json' ? limits.manifest : limits.audio
      if (file.name !== 'pack.json' && !/^songs\/[A-Za-z0-9._-]+$/.test(file.name)) {
        throw new Error('Bundle contains invalid file paths')
      }
      if (file.originalSize !== undefined && file.originalSize > maximum) {
        throw new Error('Bundle entry exceeds its expanded size limit')
      }
      declared += file.originalSize || 0
      if (declared > limits.expanded) throw new Error('Bundle exceeds its expanded size limit')
      const target = path.join(directory, 'entry-' + count)
      const fd = fs.openSync(target, 'wx')
      openFiles.add(fd)
      let size = 0
      file.ondata = (error, data, final) => {
        if (error) throw error
        size += data.length
        expanded += data.length
        if (size > maximum || expanded > limits.expanded) throw new Error('Bundle exceeds its expanded size limit')
        fs.writeSync(fd, data)
        if (final) {
          fs.closeSync(fd)
          openFiles.delete(fd)
          completed++
          result.push({ name: file.name, path: target, sizeBytes: size })
        }
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    inputFd = fs.openSync(input, 'r')
    let length
    while ((length = fs.readSync(inputFd, buffer, 0, buffer.length, null)) > 0) {
      unzip.push(buffer.subarray(0, length), false)
    }
    unzip.push(new Uint8Array(), true)
    if (!count || completed !== count) throw new Error('Bundle is truncated or empty')
    parentPort.postMessage({ files: result })
  } else {
    if (files.reduce((total, file) => total + fs.statSync(file.path).size, 0) > limits.expanded) {
      throw new Error('Bundle exceeds its expanded size limit')
    }
    outputFd = fs.openSync(input, 'wx')
    let size = 0
    const zip = new Zip((error, data) => {
      if (error) throw error
      size += data.length
      if (size > limits.compressed) throw new Error('Bundle exceeds the 500 MB limit')
      fs.writeSync(outputFd, data)
    })
    for (const file of files) {
      const entry = optimized ? new ZipDeflate(file.name, { level: 6 }) : new ZipPassThrough(file.name)
      zip.add(entry)
      const fd = fs.openSync(file.path, 'r')
      openFiles.add(fd)
      let length
      while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        entry.push(buffer.subarray(0, length), false)
      }
      entry.push(new Uint8Array(), true)
      fs.closeSync(fd)
      openFiles.delete(fd)
    }
    zip.end()
    parentPort.postMessage({ sizeBytes: size })
  }
} catch (error) {
  parentPort.postMessage({ error: error.message || 'Bundle processing failed' })
} finally {
  for (const fd of openFiles) fs.closeSync(fd)
  if (inputFd !== undefined) fs.closeSync(inputFd)
  if (outputFd !== undefined) fs.closeSync(outputFd)
}
`

let active = false

export async function runBundleWorker(job: {
  operation: 'zip' | 'unzip'
  input: string
  directory: string
  files?: BundleFile[]
  optimized?: boolean
}): Promise<{ files: BundleFile[]; sizeBytes: number }> {
  if (active) throw new Error('Another bundle is being processed; try again shortly')
  active = true
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          ...job,
          codecPath: createRequire(typeof __filename === 'string' ? __filename : import.meta.url).resolve('fflate'),
          limits: {
            compressed: MAX_BUNDLE_BYTES,
            expanded: MAX_EXPANDED_BUNDLE_BYTES,
            audio: 50 * 1024 * 1024,
            manifest: MAX_MANIFEST_BYTES,
          },
        },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      })
      let result: { files: BundleFile[]; sizeBytes: number } | undefined
      let failure: Error | undefined
      const timeout = setTimeout(() => {
        failure = new Error('Bundle processing timed out')
        void worker.terminate()
      }, 300_000)
      worker.once('message', (message: { error?: string; files?: BundleFile[]; sizeBytes?: number }) => {
        if (message.error) failure = new Error(message.error)
        else result = { files: message.files ?? [], sizeBytes: message.sizeBytes ?? 0 }
      })
      worker.once('error', (error) => { failure = error })
      worker.once('exit', (code) => {
        clearTimeout(timeout)
        if (failure || code !== 0 || !result) reject(failure ?? new Error('Bundle worker failed'))
        else resolve(result)
      })
    })
  } finally {
    active = false
  }
}
