import type { FastifyInstance } from 'fastify'

import type { PackRepository } from '../repositories/packs.js'

interface PackParams {
  id: string
}

export function isPackInput(value: unknown): value is {
  title: string
  description?: string
  status?: 'draft' | 'ready' | 'archived'
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
} {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.title === 'string' &&
    candidate.title.trim().length > 0 &&
    Array.isArray(candidate.categories)
  )
}

export async function registerPackRoutes(
  app: FastifyInstance,
  packs: PackRepository,
  preparePackDeletion?: (packId: string) => void,
): Promise<void> {
  app.get('/api/packs', async (request) => {
    const query = request.query as { includeArchived?: string }
    return packs.list(query.includeArchived === 'true')
  })

  app.get<{ Params: PackParams }>('/api/packs/:id', async (request, reply) => {
    const pack = packs.get(request.params.id)
    return pack ?? reply.code(404).send({ error: 'Pack not found' })
  })

  app.get<{ Params: PackParams }>('/api/packs/:id/export', async (request, reply) => {
    const pack = packs.get(request.params.id)
    if (!pack) return reply.code(404).send({ error: 'Pack not found' })
    reply.header('Content-Disposition', `attachment; filename="friends-trivia-pack-${request.params.id}.json"`)
    return { schemaVersion: 1, ...(pack as object) }
  })

  app.post('/api/packs', async (request, reply) => {
    const body = request.body as { title?: unknown; description?: unknown }
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return reply.code(400).send({ error: 'A pack title is required' })
    }
    const description = typeof body.description === 'string' ? body.description : undefined
    return reply
      .code(201)
      .send(
        packs.create(
          description
            ? { title: body.title.trim(), description }
            : { title: body.title.trim() },
        ),
      )
  })

  app.post('/api/packs/import', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    if (!body || body.schemaVersion !== 1 || !isPackInput(body)) {
      return reply.code(400).send({ error: 'Invalid or unsupported pack manifest' })
    }
    const created = packs.create(
      body.description
        ? { title: body.title.trim(), description: body.description }
        : { title: body.title.trim() },
    ) as { id: string }
    try {
      const imported = {
        title: body.title,
        ...(body.description ? { description: body.description } : {}),
        status: 'draft' as const,
        defaultSettings: body.defaultSettings,
        categories: body.categories.map((category) => ({
          title: category.title,
          clues: category.clues.map((clue) => {
            const importedClue = {
              type: clue.type,
              boardValue: clue.boardValue,
              prompt: clue.prompt,
              mediaAssetId: null,
              revealMediaAssetId: null,
              config: clue.config,
              finalQuestion: Boolean(clue.finalQuestion),
            }
            return clue.timerSeconds === undefined
              ? importedClue
              : { ...importedClue, timerSeconds: clue.timerSeconds }
          }),
        })),
      }
      const result = packs.replace(created.id, imported)
      return reply.code(201).send(result)
    } catch (error) {
      packs.remove(created.id)
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Invalid pack manifest' })
    }
  })

  app.put<{ Params: PackParams }>('/api/packs/:id', async (request, reply) => {
    if (!isPackInput(request.body)) {
      return reply.code(400).send({ error: 'Invalid pack payload' })
    }
    try {
      const pack = packs.replace(request.params.id, request.body)
      return pack ?? reply.code(404).send({ error: 'Pack not found' })
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'Invalid pack payload' })
    }
  })

  app.delete<{ Params: PackParams }>('/api/packs/:id', async (request, reply) => {
    preparePackDeletion?.(request.params.id)
    const result = packs.remove(request.params.id)
    if (result === 'not_found') {
      return reply.code(404).send({ error: 'Pack not found' })
    }
    return reply.code(204).send()
  })
}
