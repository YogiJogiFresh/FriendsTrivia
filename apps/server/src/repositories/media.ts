import type Database from 'better-sqlite3'

import { createId } from '../ids.js'

export interface MediaAsset {
  id: string
  relativePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  durationSeconds: number | null
  createdAt: string
}

interface MediaRow {
  id: string
  relative_path: string
  original_name: string
  mime_type: string
  size_bytes: number
  duration_seconds: number | null
  created_at: string
}

function mapMedia(row: MediaRow): MediaAsset {
  return {
    id: row.id,
    relativePath: row.relative_path,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
  }
}

export class MediaRepository {
  constructor(private readonly database: Database.Database) {}

  list(): MediaAsset[] {
    const rows = this.database
      .prepare('SELECT * FROM media_assets ORDER BY created_at DESC')
      .all() as MediaRow[]
    return rows.map(mapMedia)
  }

  get(id: string): MediaAsset | undefined {
    const row = this.database.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as
      | MediaRow
      | undefined
    return row ? mapMedia(row) : undefined
  }

  findByPath(relativePath: string): MediaAsset | undefined {
    const row = this.database
      .prepare('SELECT * FROM media_assets WHERE relative_path = ?')
      .get(relativePath) as MediaRow | undefined
    return row ? mapMedia(row) : undefined
  }

  create(input: {
    relativePath: string
    originalName: string
    mimeType: string
    sizeBytes: number
  }): MediaAsset {
    const id = createId()
    this.database
      .prepare(
        `INSERT INTO media_assets
         (id, relative_path, original_name, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.relativePath, input.originalName, input.mimeType, input.sizeBytes)
    const asset = this.get(id)
    if (!asset) throw new Error('Media asset was not created')
    return asset
  }

  createIfMissing(input: {
    relativePath: string
    originalName: string
    mimeType: string
    sizeBytes: number
  }): MediaAsset {
    return this.findByPath(input.relativePath) ?? this.create(input)
  }

  remove(id: string): boolean {
    return this.database.prepare('DELETE FROM media_assets WHERE id = ?').run(id).changes > 0
  }
}
