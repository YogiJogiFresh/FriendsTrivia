import type { HistoryStore, HistoryRow } from '../domain.js'
import { domainFrom, type DomainSource } from '../sqliteStore.js'
import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
export async function registerHistoryRoutes(app: FastifyInstance, source: DomainSource | HistoryStore): Promise<void> {
  const history = 'header' in source ? source : domainFrom(source).history
  app.get('/api/history', async () => (await history.list()).items)
  app.delete('/api/history', async () => {
    return { deletedCount: await history.removeAllCompleted() }
  })
  app.delete<{
    Params: {
      id: string
    }
  }>('/api/history/:id', async (request, reply) => {
    const result = await history.removeCompleted(request.params.id)
    if (result === 'deleted') return reply.code(204).send()
    return result === 'active'
      ? reply.code(409).send({ error: 'Only completed or abandoned games can be deleted' })
      : reply.code(404).send({ error: 'Game not found' })
  })
  app.get<{
    Params: {
      id: string
    }
  }>('/api/history/:id', async (request, reply) => {
    const room = (await history.header(request.params.id))
    if (!room)
      return reply.code(404).send({ error: 'Game not found' })
    async function* detail() {
      yield `{"room":${JSON.stringify(room)},"players":[`
      yield* jsonRows((cursor) => history.players(request.params.id, { limit: 100, ...(cursor ? { cursor } : {}) }))
      yield '],"submissions":['
      yield* jsonRows((cursor) => history.submissions(request.params.id, { limit: 100, ...(cursor ? { cursor } : {}) }))
      yield ']}'
    }
    return reply.type('application/json').send(Readable.from(detail()))
  })
  app.get<{
    Params: {
      id: string
    }
  }>('/api/history/:id/export.csv', async (request, reply) => {
    const first = await history.exportRows(request.params.id, { limit: 100 })
    if (first.items.length === 0)
      return reply.code(404).send({ error: 'No results found' })
    const headers = Object.keys(first.items[0] ?? {})
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
    async function* csv() {
      yield headers.map(escape).join(',')
      let page = first
      do {
        for (const row of page.items) yield `\r\n${headers.map((header) => escape(row[header])).join(',')}`
        if (!page.cursor) break
        page = await history.exportRows(request.params.id, { cursor: page.cursor, limit: 100 })
      } while (true)
    }
    reply
      .type('text/csv')
      .header('Content-Disposition', `attachment; filename="friends-trivia-${request.params.id}.csv"`)
    return reply.send(Readable.from(csv()))
  })
}

async function* jsonRows(read: (cursor?: string) => Promise<{ items: HistoryRow[]; cursor?: string }>) {
  let cursor: string | undefined
  let first = true
  do {
    const page = await read(cursor)
    for (const row of page.items) {
      yield `${first ? '' : ','}${JSON.stringify(row)}`
      first = false
    }
    cursor = page.cursor
  } while (cursor)
}
