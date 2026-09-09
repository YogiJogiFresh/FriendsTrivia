import fs from 'node:fs'
import path from 'node:path'

const allowedAudioTypes = new Map([
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
])

const audioTypesByExtension = new Map(
  Array.from(allowedAudioTypes, ([mimeType, extension]) => [extension, mimeType]),
)

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024

export function audioExtension(mimeType: string): string | undefined {
  return allowedAudioTypes.get(mimeType.toLowerCase())
}

export function resolveContentPath(contentRoot: string, relativePath: string): string {
  const root = path.resolve(contentRoot)
  const resolved = path.resolve(root, relativePath)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the configured content directory')
  }
  return resolved
}

export function ensureContentDirectories(contentRoot: string): void {
  fs.mkdirSync(resolveContentPath(contentRoot, 'songs'), { recursive: true })
  fs.mkdirSync(resolveContentPath(contentRoot, 'packs'), { recursive: true })
}

export function audioTypeForFile(fileName: string): string | undefined {
  return audioTypesByExtension.get(path.extname(fileName).toLowerCase())
}
