import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../database.js'
import { MediaRepository } from '../repositories/media.js'
import { PackRepository } from '../repositories/packs.js'
import { createPackBundle, importPackBundle } from './packBundles.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

describe('portable pack bundles', () => {
  it('exports referenced songs and restores clue media links on import', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'friends-trivia-export-'))
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'friends-trivia-import-'))
    fs.mkdirSync(path.join(sourceRoot, 'songs'))
    fs.mkdirSync(path.join(targetRoot, 'songs'))
    const sourceDatabase = openDatabase(':memory:')
    const targetDatabase = openDatabase(':memory:')
    cleanups.push(() => {
      sourceDatabase.close()
      targetDatabase.close()
      fs.rmSync(sourceRoot, { recursive: true, force: true })
      fs.rmSync(targetRoot, { recursive: true, force: true })
    })

    const sourcePacks = new PackRepository(sourceDatabase)
    const sourceMedia = new MediaRepository(sourceDatabase)
    fs.writeFileSync(path.join(sourceRoot, 'songs', 'opening.mp3'), 'song bytes')
    const song = sourceMedia.create({
      relativePath: path.join('songs', 'opening.mp3'),
      originalName: 'Opening.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 10,
    })
    const created = sourcePacks.create({ title: 'Portable Party' }) as { id: string }
    sourcePacks.replace(created.id, {
      title: 'Portable Party',
      status: 'ready',
      categories: [
        {
          title: 'Music',
          clues: [
            {
              type: 'music_free_text',
              boardValue: 100,
              prompt: 'Name it',
              mediaAssetId: song.id,
              revealMediaAssetId: song.id,
              config: { correctAnswer: 'Answer' },
            },
          ],
        },
      ],
    })

    const bundle = createPackBundle(
      sourcePacks.get(created.id) as Parameters<typeof createPackBundle>[0],
      sourceMedia,
      sourceRoot,
    )
    const targetPacks = new PackRepository(targetDatabase)
    const targetMedia = new MediaRepository(targetDatabase)
    const imported = importPackBundle(bundle, targetPacks, targetMedia, targetRoot) as {
      status: string
      categories: Array<{
        clues: Array<{ mediaAssetId: string; revealMediaAssetId: string }>
      }>
    }

    const importedClue = imported.categories[0]?.clues[0]
    expect(imported.status).toBe('ready')
    expect(importedClue?.mediaAssetId).toBeTruthy()
    expect(importedClue?.mediaAssetId).not.toBe(song.id)
    expect(importedClue?.revealMediaAssetId).toBe(importedClue?.mediaAssetId)
    const importedMedia = targetMedia.get(importedClue?.mediaAssetId ?? '')
    expect(importedMedia).toMatchObject({
      originalName: 'Opening.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 10,
    })
    expect(
      fs.readFileSync(path.join(targetRoot, importedMedia?.relativePath ?? ''), 'utf8'),
    ).toBe('song bytes')
  })

  it('rejects a bundle whose song entry is missing', () => {
    const database = openDatabase(':memory:')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'friends-trivia-invalid-bundle-'))
    fs.mkdirSync(path.join(root, 'songs'))
    cleanups.push(() => {
      database.close()
      fs.rmSync(root, { recursive: true, force: true })
    })

    expect(() =>
      importPackBundle(
        new Uint8Array([1, 2, 3]),
        new PackRepository(database),
        new MediaRepository(database),
        root,
      ),
    ).toThrow()
  })
})
