import { asPersistence, type DatabaseSource, type Persistence } from './persistence.js'
import type { PackDocument } from './domain.js'
import { createId } from './ids.js'
export interface PackSummary {
  id: string
  title: string
  description: string
  status: 'draft' | 'ready' | 'archived'
  categoryCount: number
  clueCount: number
  ordinaryClueCount: number
  createdAt: string
  updatedAt: string
}
interface PackRow {
  revision: number
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
export class SqlitePackStore {
  private readonly database: Persistence
  constructor(database: DatabaseSource) { this.database = asPersistence(database) }
  async list(includeArchived = false): Promise<PackSummary[]> {
    return (await this.database.statement('packList').all(includeArchived ? 1 : 0)) as PackSummary[]
  }
  async get(id: string): Promise<PackDocument | undefined> {
    const pack = (await this.database.statement('packGet').get(id)) as PackRow | undefined
    if (!pack)
      return undefined
    const categories = (await this.database.statement('packCategories').all(id)) as CategoryRow[]
    const getClues = this.database.statement('categoryClues')
    return {
      id: pack.id,
      revision: String(pack.revision),
      title: pack.title,
      description: pack.description,
      status: pack.status,
      defaultSettings: JSON.parse(pack.default_settings_json) as unknown,
      createdAt: pack.created_at,
      updatedAt: pack.updated_at,
      categories: await Promise.all(categories.map(async (category) => ({
        id: category.id,
        title: category.title,
        position: category.position,
        clues: ((await getClues.all(category.id)) as ClueRow[]).map((clue) => ({
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
      }))),
    }
  }
  async create(input: {
    title: string
    description?: string
  }): Promise<PackDocument> {
    const id = createId()
    await this.database.statement('packInsert').run(id, input.title, input.description ?? '')
    return (await this.get(id))!
  }
  async replace(id: string, input: {
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
  }): Promise<PackDocument | undefined> {
    if (!(await this.get(id)))
      return undefined
    await this.database.transaction(async () => {
      await this.database.statement('packUpdate').run(input.title, input.description ?? '', input.status ?? 'draft', JSON.stringify(input.defaultSettings ?? {}), id)
      await this.database.statement('packArchiveClues').run(id)
      await this.database.statement('packArchiveCategories').run(id)
      const insertCategory = this.database.statement('categoryInsert')
      const updateCategory = this.database.statement('categoryUpdate')
      const insertClue = this.database.statement('clueInsert')
      const updateClue = this.database.statement('clueUpdate')
      for (const [categoryIndex, category] of input.categories.entries()) {
        const categoryId = category.id ?? createId()
        const updatedCategory = category.id
          ? (await updateCategory.run(category.title, categoryIndex, categoryId, id)).changes
          : 0
        if (!updatedCategory) {
          await insertCategory.run(categoryId, id, category.title, categoryIndex)
        }
        for (const [clueIndex, clue] of category.clues.entries()) {
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
            ? (await updateClue.run(...values, clueId)).changes
            : 0
          if (!updatedClue) {
            await insertClue.run(clueId, categoryId, clue.type, clue.boardValue, clueIndex, clue.prompt, clue.timerSeconds ?? 30, JSON.stringify(clue.config), clue.mediaAssetId ?? null, clue.revealMediaAssetId ?? null, clue.finalQuestion ? 1 : 0)
          }
        }
      }
    })
    return (await this.get(id))
  }
  async archive(id: string): Promise<boolean> {
    return ((await this.database.statement('packArchive').run(id)).changes > 0)
  }
  async remove(id: string): Promise<'deleted' | 'not_found'> {
    return (await this.database.transaction(async () => {
      const pack = (await this.database.statement('packExists').get(id))
      if (!pack)
        return 'not_found'
      await this.database.statement('packDeleteRooms').run(id)
      await this.database.statement('packDelete').run(id)
      return 'deleted'
    }))
  }
}
