import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'

export async function registerHistoryRoutes(
  app: FastifyInstance,
  database: Database.Database,
): Promise<void> {
  app.get('/api/history', async () =>
    database
      .prepare(
        `SELECT r.id, r.code, p.title AS packTitle, r.status, r.created_at AS createdAt,
                r.completed_at AS completedAt, COUNT(DISTINCT pl.id) AS playerCount
         FROM rooms r
         JOIN packs p ON p.id = r.pack_id
         LEFT JOIN players pl ON pl.room_id = r.id AND pl.kicked = 0
         WHERE r.status IN ('finished', 'abandoned')
         GROUP BY r.id
         ORDER BY r.updated_at DESC
         LIMIT 100`,
      )
      .all(),
  )

  app.delete('/api/history', async () => {
    const result = database
      .prepare("DELETE FROM rooms WHERE status IN ('finished', 'abandoned')")
      .run()
    return { deletedCount: result.changes }
  })

  app.delete<{ Params: { id: string } }>('/api/history/:id', async (request, reply) => {
    const result = database
      .prepare(
        "DELETE FROM rooms WHERE id = ? AND status IN ('finished', 'abandoned')",
      )
      .run(request.params.id)
    if (result.changes > 0) return reply.code(204).send()

    const room = database.prepare('SELECT status FROM rooms WHERE id = ?').get(request.params.id)
    return room
      ? reply.code(409).send({ error: 'Only completed or abandoned games can be deleted' })
      : reply.code(404).send({ error: 'Game not found' })
  })

  app.get<{ Params: { id: string } }>('/api/history/:id', async (request, reply) => {
    const room = database
      .prepare(
        `SELECT r.id, r.code, p.title AS packTitle, r.status, r.settings_json AS settings,
                r.created_at AS createdAt, r.completed_at AS completedAt
         FROM rooms r JOIN packs p ON p.id = r.pack_id WHERE r.id = ?`,
      )
      .get(request.params.id)
    if (!room) return reply.code(404).send({ error: 'Game not found' })

    const players = database
      .prepare(
        `SELECT p.id, p.nickname, p.team_name AS teamName, COALESCE(SUM(s.delta), 0) AS score
         FROM players p LEFT JOIN score_events s ON s.player_id = p.id
         WHERE p.room_id = ? GROUP BY p.id ORDER BY score DESC`,
      )
      .all(request.params.id)
    const submissions = database
      .prepare(
        `SELECT s.player_id AS playerId, s.clue_id AS clueId,
                s.category_title AS categoryTitle, s.clue_prompt AS cluePrompt,
                s.clue_type AS clueType, s.answer_json AS answer,
                s.elapsed_ms AS elapsedMs, s.correct, s.rank,
                s.points_awarded AS pointsAwarded, s.evaluation_json AS evaluation
         FROM submissions s WHERE s.room_id = ? ORDER BY s.received_at`,
      )
      .all(request.params.id)
    return { room, players, submissions }
  })

  app.get<{ Params: { id: string } }>('/api/history/:id/export.csv', async (request, reply) => {
    const rows = database
      .prepare(
        `SELECT p.nickname, p.team_name AS team, s.category_title AS category, s.clue_prompt AS prompt,
                s.clue_type AS type,
                s.answer_json, s.elapsed_ms, s.correct, s.rank, s.points_awarded
         FROM submissions s
         JOIN players p ON p.id = s.player_id
         WHERE s.room_id = ? ORDER BY s.received_at, p.nickname`,
      )
      .all(request.params.id) as Array<Record<string, unknown>>
    if (rows.length === 0) return reply.code(404).send({ error: 'No results found' })

    const headers = Object.keys(rows[0] ?? {})
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const csv = [
      headers.map(escape).join(','),
      ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
    ].join('\r\n')
    reply
      .type('text/csv')
      .header('Content-Disposition', `attachment; filename="friends-trivia-${request.params.id}.csv"`)
    return csv
  })
}
