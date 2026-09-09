import type Database from 'better-sqlite3'

import { createId } from '../ids.js'
import { isRevealGif } from '../gifs.js'

export interface PackSummary {
  id: string
  title: string
  description: string
  status: 'draft' | 'ready' | 'archived'
  categoryCount: number
  clueCount: number
  createdAt: string
  updatedAt: string
}

interface PackRow {
  id: string
  title: string
  description: string
  status: PackSummary['status']
  default_settings_json: string
  created_at: string
  updated_at: string
}

interface CategoryRow {
  id: string
  pack_id: string
  title: string
  position: number
}

interface ClueRow {
  id: string
  category_id: string
  type: string
  board_value: number
  position: number
  prompt: string
  timer_seconds: number
  config_json: string
  media_asset_id: string | null
  reveal_media_asset_id: string | null
  is_final: number
}

export class PackRepository {
  constructor(private readonly database: Database.Database) {}

  list(includeArchived = false): PackSummary[] {
    return this.database
      .prepare(
        `SELECT p.id, p.title, p.description, p.status, p.created_at AS createdAt,
                p.updated_at AS updatedAt, COUNT(DISTINCT c.id) AS categoryCount,
                COUNT(q.id) AS clueCount
         FROM packs p
         LEFT JOIN categories c ON c.pack_id = p.id AND c.archived = 0
         LEFT JOIN clues q ON q.category_id = c.id AND q.archived = 0
         WHERE (? = 1 OR p.status != 'archived')
         GROUP BY p.id
         ORDER BY p.updated_at DESC`,
      )
      .all(includeArchived ? 1 : 0) as PackSummary[]
  }

  get(id: string): unknown | undefined {
    const pack = this.database.prepare('SELECT * FROM packs WHERE id = ?').get(id) as
      | PackRow
      | undefined
    if (!pack) return undefined

    const categories = this.database
      .prepare(
        'SELECT * FROM categories WHERE pack_id = ? AND archived = 0 ORDER BY position',
      )
      .all(id) as CategoryRow[]
    const getClues = this.database.prepare(
      'SELECT * FROM clues WHERE category_id = ? AND archived = 0 ORDER BY position',
    )

    return {
      id: pack.id,
      title: pack.title,
      description: pack.description,
      status: pack.status,
      defaultSettings: JSON.parse(pack.default_settings_json) as unknown,
      createdAt: pack.created_at,
      updatedAt: pack.updated_at,
      categories: categories.map((category) => ({
        id: category.id,
        title: category.title,
        position: category.position,
        clues: (getClues.all(category.id) as ClueRow[]).map((clue) => ({
          id: clue.id,
          type: clue.type,
          boardValue: clue.board_value,
          position: clue.position,
          prompt: clue.prompt,
          timerSeconds: clue.timer_seconds,
          mediaAssetId: clue.media_asset_id,
          revealMediaAssetId: clue.reveal_media_asset_id,
          finalQuestion: Boolean(clue.is_final),
          config: JSON.parse(clue.config_json) as unknown,
        })),
      })),
    }
  }

  create(input: { title: string; description?: string }): unknown {
    const id = createId()
    this.database
      .prepare('INSERT INTO packs (id, title, description) VALUES (?, ?, ?)')
      .run(id, input.title, input.description ?? '')
    return this.get(id)
  }

  replace(
    id: string,
    input: {
      title: string
      description?: string
      status?: PackSummary['status']
      defaultSettings?: unknown
      categories: Array<{
        id?: string
        title: string
        clues: Array<{
          id?: string
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
    },
  ): unknown | undefined {
    if (!this.get(id)) return undefined
    this.validate(input)

    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE packs SET title = ?, description = ?, status = ?,
           default_settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .run(
          input.title,
          input.description ?? '',
          input.status ?? 'draft',
          JSON.stringify(input.defaultSettings ?? {}),
          id,
        )
      this.database
        .prepare(
          `UPDATE clues SET archived = 1, position = -rowid
           WHERE category_id IN (SELECT id FROM categories WHERE pack_id = ? AND archived = 0)`,
        )
        .run(id)
      this.database
        .prepare(
          `UPDATE categories SET archived = 1, position = -rowid
           WHERE pack_id = ? AND archived = 0`,
        )
        .run(id)

      const insertCategory = this.database.prepare(
        `INSERT INTO categories (id, pack_id, title, position, archived)
         VALUES (?, ?, ?, ?, 0)`,
      )
      const updateCategory = this.database.prepare(
        `UPDATE categories SET title = ?, position = ?, archived = 0
         WHERE id = ? AND pack_id = ?`,
      )
      const insertClue = this.database.prepare(
        `INSERT INTO clues
         (id, category_id, type, board_value, position, prompt, timer_seconds,
          config_json, media_asset_id, reveal_media_asset_id, is_final, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      const updateClue = this.database.prepare(
        `UPDATE clues SET category_id = ?, type = ?, board_value = ?, position = ?,
         prompt = ?, timer_seconds = ?, config_json = ?, media_asset_id = ?,
         reveal_media_asset_id = ?, is_final = ?, archived = 0
         WHERE id = ?`,
      )

      input.categories.forEach((category, categoryIndex) => {
        const categoryId = category.id ?? createId()
        const updatedCategory = category.id
          ? updateCategory.run(category.title, categoryIndex, categoryId, id).changes
          : 0
        if (!updatedCategory) {
          insertCategory.run(categoryId, id, category.title, categoryIndex)
        }
        category.clues.forEach((clue, clueIndex) => {
          const clueId = clue.id ?? createId()
          const values = [
            categoryId,
            clue.type,
            clue.boardValue,
            clueIndex,
            clue.prompt,
            clue.timerSeconds ?? 30,
            JSON.stringify(clue.config),
            clue.mediaAssetId ?? null,
            clue.revealMediaAssetId ?? null,
            clue.finalQuestion ? 1 : 0,
          ] as const
          const updatedClue = clue.id
            ? updateClue.run(...values, clueId).changes
            : 0
          if (!updatedClue) {
            insertClue.run(
              clueId,
              categoryId,
              clue.type,
              clue.boardValue,
              clueIndex,
              clue.prompt,
              clue.timerSeconds ?? 30,
              JSON.stringify(clue.config),
              clue.mediaAssetId ?? null,
              clue.revealMediaAssetId ?? null,
              clue.finalQuestion ? 1 : 0,
            )
          }
        })
      })
    })()

    return this.get(id)
  }

  private validate(input: {
    title: string
    status?: PackSummary['status']
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
  }): void {
    if (!input.title.trim()) throw new Error('Pack title is required')
    if (input.categories.length > 12) throw new Error('A pack can contain at most 12 categories')
    if (input.status === 'ready' && input.categories.length === 0) {
      throw new Error('A ready pack must contain at least one category')
    }
    const finalQuestionCount = input.categories
      .flatMap((category) => category.clues)
      .filter((clue) => clue.finalQuestion).length
    if (finalQuestionCount > 1) throw new Error('A pack can contain only one Final Question')

    for (const category of input.categories) {
      if (!category.title.trim()) throw new Error('Every category needs a title')
      if (category.clues.length > 20) throw new Error('A category can contain at most 20 clues')
      for (const clue of category.clues) {
        if (
          !['music_multiple_choice', 'music_free_text', 'price_slider'].includes(clue.type)
        ) {
          throw new Error('Unsupported clue type')
        }
        if (!clue.prompt.trim()) throw new Error('Every clue needs a prompt')
        if (!Number.isSafeInteger(clue.boardValue) || clue.boardValue <= 0) {
          throw new Error('Clue values must be positive integers')
        }
        if (
          clue.timerSeconds !== undefined &&
          (!Number.isInteger(clue.timerSeconds) ||
            clue.timerSeconds < 5 ||
            clue.timerSeconds > 300)
        ) {
          throw new Error('Clue timers must be between 5 and 300 seconds')
        }
        const config =
          clue.config && typeof clue.config === 'object'
            ? (clue.config as Record<string, unknown>)
            : {}
        if (config.revealGif !== undefined && !isRevealGif(config.revealGif)) {
          throw new Error('The answer reveal GIF is invalid')
        }
        if (clue.type.startsWith('music_')) {
          if (input.status === 'ready' && !clue.mediaAssetId) {
            throw new Error('Every music clue in a ready pack needs an uploaded song')
          }
          if (clue.type === 'music_multiple_choice') {
            const choices = Array.isArray(config.choices)
              ? config.choices.filter(
                  (choice): choice is string =>
                    typeof choice === 'string' && Boolean(choice.trim()),
                )
              : []
            const choiceCount = Array.isArray(config.choices) ? config.choices.length : 0
            if (choices.length < 2 || choices.length !== choiceCount) {
              throw new Error('Multiple-choice clues need at least two choices')
            }
            const correctAnswer =
              typeof config.correctAnswer === 'string' ? config.correctAnswer : ''
            if (
              correctAnswer &&
              !choices.some(
                (choice) =>
                  choice.trim().toLocaleLowerCase() ===
                  correctAnswer.trim().toLocaleLowerCase(),
              )
            ) {
              throw new Error('The correct answer must be one of the choices')
            }
          }
          if (
            typeof config.correctAnswer !== 'string' ||
            !config.correctAnswer.trim()
          ) {
            throw new Error('Every music clue needs a correct answer')
          }
        } else {
          const correctPrice = Number(config.correctPrice)
          const min = Number(config.min)
          const max = Number(config.max)
          if (
            !Number.isFinite(correctPrice) ||
            !Number.isFinite(min) ||
            !Number.isFinite(max) ||
            min >= max ||
            correctPrice < min ||
            correctPrice > max
          ) {
            throw new Error('Price clues need valid bounds and a target inside the range')
          }
        }
      }
    }
  }

  archive(id: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE packs SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(id).changes > 0
    )
  }

  remove(id: string): 'deleted' | 'not_found' {
    return this.database.transaction(() => {
      const pack = this.database.prepare('SELECT id FROM packs WHERE id = ?').get(id)
      if (!pack) return 'not_found'

      this.database.prepare('DELETE FROM rooms WHERE pack_id = ?').run(id)
      this.database.prepare('DELETE FROM packs WHERE id = ?').run(id)
      return 'deleted'
    })()
  }
}
