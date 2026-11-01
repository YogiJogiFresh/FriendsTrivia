// SQLite implementation details; shared domain callers do not consume statements.
export const statements = {
  'mediaList': {
    "sqlite": "SELECT * FROM media_assets ORDER BY created_at DESC"
  },
  'mediaGet': {
    "sqlite": "SELECT * FROM media_assets WHERE id = ?"
  },
  'mediaFindPath': {
    "sqlite": "SELECT * FROM media_assets WHERE relative_path = ?"
  },
  'mediaInsert': {
    "sqlite": "INSERT INTO media_assets\n         (id, relative_path, original_name, mime_type, size_bytes)\n         VALUES (?, ?, ?, ?, ?)"
  },
  'mediaDelete': {
    "sqlite": "DELETE FROM media_assets WHERE id = ?"
  },
  'packList': {
    "sqlite": "SELECT p.id, p.title, p.description, p.status, p.created_at AS createdAt,\n                p.updated_at AS updatedAt, COUNT(DISTINCT c.id) AS categoryCount,\n                COUNT(q.id) AS clueCount,\n                SUM(CASE WHEN q.is_final = 0 THEN 1 ELSE 0 END) AS ordinaryClueCount\n         FROM packs p\n         LEFT JOIN categories c ON c.pack_id = p.id AND c.archived = 0\n         LEFT JOIN clues q ON q.category_id = c.id AND q.archived = 0\n         WHERE (? = 1 OR p.status != 'archived')\n         GROUP BY p.id\n         ORDER BY p.updated_at DESC"
  },
  'packGet': {
    "sqlite": "SELECT * FROM packs WHERE id = ?"
  },
  'packCategories': {
    "sqlite": "SELECT * FROM categories WHERE pack_id = ? AND archived = 0 ORDER BY position"
  },
  'categoryClues': {
    "sqlite": "SELECT * FROM clues WHERE category_id = ? AND archived = 0 ORDER BY position"
  },
  'packInsert': {
    "sqlite": "INSERT INTO packs (id, title, description) VALUES (?, ?, ?)"
  },
  'packUpdate': {
    "sqlite": "UPDATE packs SET title = ?, description = ?, status = ?,\n           default_settings_json = ?, updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ?"
  },
  'packArchiveClues': {
    "sqlite": "UPDATE clues SET archived = 1, position = -rowid\n           WHERE category_id IN (SELECT id FROM categories WHERE pack_id = ? AND archived = 0)"
  },
  'packArchiveCategories': {
    "sqlite": "UPDATE categories SET archived = 1, position = -rowid\n           WHERE pack_id = ? AND archived = 0"
  },
  'categoryInsert': {
    "sqlite": "INSERT INTO categories (id, pack_id, title, position, archived)\n         VALUES (?, ?, ?, ?, 0)"
  },
  'categoryUpdate': {
    "sqlite": "UPDATE categories SET title = ?, position = ?, archived = 0\n         WHERE id = ? AND pack_id = ?"
  },
  'clueInsert': {
    "sqlite": "INSERT INTO clues\n         (id, category_id, type, board_value, position, prompt, timer_seconds,\n          config_json, media_asset_id, reveal_media_asset_id, is_final, archived)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
  },
  'clueUpdate': {
    "sqlite": "UPDATE clues SET category_id = ?, type = ?, board_value = ?, position = ?,\n         prompt = ?, timer_seconds = ?, config_json = ?, media_asset_id = ?,\n         reveal_media_asset_id = ?, is_final = ?, archived = 0\n         WHERE id = ?"
  },
  'packArchive': {
    "sqlite": "UPDATE packs SET status = 'archived', updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ?"
  },
  'packExists': {
    "sqlite": "SELECT id FROM packs WHERE id = ?"
  },
  'packDeleteRooms': {
    "sqlite": "DELETE FROM rooms WHERE pack_id = ?"
  },
  'packDelete': {
    "sqlite": "DELETE FROM packs WHERE id = ?"
  },
  'roomPackEligibility': {
    "sqlite": "SELECT p.id, p.status, COUNT(q.id) AS clue_count,\n                SUM(CASE WHEN q.is_final = 0 THEN 1 ELSE 0 END) AS ordinary_clue_count\n         FROM packs p\n         LEFT JOIN categories c ON c.pack_id = p.id AND c.archived = 0\n         LEFT JOIN clues q ON q.category_id = c.id AND q.archived = 0\n         WHERE p.id = ? AND p.status != 'archived'\n         GROUP BY p.id"
  },
  'roomInsert': {
    "sqlite": "INSERT INTO rooms\n             (id, code, pack_id, host_token_hash, status, settings_json, state_json)\n             VALUES (?, ?, ?, ?, 'lobby', ?, ?)"
  },
  'roomGet': {
    "sqlite": "SELECT * FROM rooms WHERE id = ?"
  },
  'roomByCode': {
    "sqlite": "SELECT * FROM rooms WHERE code = ?"
  },
  'roomPlayerCount': {
    "sqlite": "SELECT COUNT(*) AS count FROM players WHERE room_id = ? AND kicked = 0"
  },
  'playerInsert': {
    "sqlite": "INSERT INTO players\n           (id, room_id, nickname, team_name, reconnect_token_hash, connected)\n           VALUES (?, ?, ?, ?, ?, 1)"
  },
  'playerGet': {
    "sqlite": "SELECT * FROM players WHERE id = ?"
  },
  'roomPlayers': {
    "sqlite": "SELECT * FROM players WHERE room_id = ? AND kicked = 0 ORDER BY joined_at"
  },
  'roomScores': {
    "sqlite": "SELECT p.id AS playerId, p.nickname, p.team_name AS teamName, p.connected,\n                COALESCE(SUM(s.delta), 0) AS score\n         FROM players p\n         LEFT JOIN score_events s ON s.player_id = p.id\n         WHERE p.room_id = ? AND p.kicked = 0\n         GROUP BY p.id\n         ORDER BY score DESC, p.joined_at"
  },
  'playerConnected': {
    "sqlite": "UPDATE players SET connected = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?"
  },
  'roomJoiningLocked': {
    "sqlite": "UPDATE rooms SET joining_locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  },
  'playerKick': {
    "sqlite": "UPDATE players SET kicked = 1, connected = 0, last_seen_at = CURRENT_TIMESTAMP\n           WHERE id = ? AND room_id = ?"
  },
  'roomSaveState': {
    "sqlite": "UPDATE rooms SET state_json = ?, status = ?, state_version = state_version + 1,\n           updated_at = CURRENT_TIMESTAMP,\n           completed_at = CASE WHEN ? IN ('finished', 'abandoned') THEN CURRENT_TIMESTAMP ELSE completed_at END\n           WHERE id = ? AND state_version = ?"
  },
  'roomInsertSnapshot': {
    "sqlite": "INSERT INTO game_snapshots (room_id, state_version, state_json)\n           VALUES (?, ?, ?)"
  },
  'roomActive': {
    "sqlite": "SELECT * FROM rooms WHERE status = 'active'"
  },
  'playersDisconnectAll': {
    "sqlite": "UPDATE players SET connected = 0"
  },
  'packRooms': {
    "sqlite": "SELECT id FROM rooms WHERE pack_id = ?"
  },
  'packBoard': {
    "sqlite": "SELECT c.id AS categoryId, c.title AS categoryTitle, c.position AS categoryPosition,\n                q.id AS clueId, q.board_value AS boardValue, q.position AS cluePosition,\n                q.type AS clueType\n         FROM categories c\n         JOIN clues q ON q.category_id = c.id\n         WHERE c.pack_id = ? AND c.archived = 0 AND q.archived = 0 AND q.is_final = 0\n         ORDER BY c.position, q.position"
  },
  'clueWageredPlayers': {
    "sqlite": "SELECT w.player_id AS playerId\n                   FROM final_wagers w\n                   JOIN players p ON p.id = w.player_id\n                   WHERE w.room_id = ? AND w.clue_id = ? AND p.kicked = 0"
  },
  'clueResults': {
    "sqlite": "SELECT player_id AS playerId, answer_json AS answer, correct, rank,\n                        points_awarded AS pointsAwarded, evaluation_json AS evaluation\n                 FROM submissions WHERE room_id = ? AND clue_id = ?"
  },
  'clueSubmissionReceipts': {
    "sqlite": "SELECT player_id AS playerId, elapsed_ms AS elapsedMs, received_at AS receivedAt\n               FROM submissions WHERE room_id = ? AND clue_id = ?"
  },
  'packOrdinaryClues': {
    "sqlite": "SELECT q.id\n           FROM clues q\n           JOIN categories c ON c.id = q.category_id\n           WHERE c.pack_id = ? AND c.archived = 0 AND q.archived = 0 AND q.is_final = 0"
  },
  'clueInsertWager': {
    "sqlite": "INSERT INTO final_wagers (room_id, player_id, clue_id, amount)\n           VALUES (?, ?, ?, ?)"
  },
  'clueWagerCount': {
    "sqlite": "SELECT COUNT(*) AS count\n           FROM final_wagers w\n           JOIN players p ON p.id = w.player_id\n           WHERE w.room_id = ? AND w.clue_id = ? AND p.kicked = 0"
  },
  'clueInsertAnswer': {
    "sqlite": "INSERT INTO submissions\n           (id, room_id, player_id, clue_id, answer_json, elapsed_ms,\n            clue_prompt, clue_type, category_title, received_at)\n           VALUES (?, ?, ?, ?, ?, ?, ?, ?, (\n             SELECT c.title FROM categories c WHERE c.id = ?\n           ), ?)"
  },
  'clueAwardedPoints': {
    "sqlite": "SELECT player_id AS playerId, COALESCE(points_awarded, 0) AS points\n         FROM submissions WHERE room_id = ? AND clue_id = ? AND points_awarded != 0"
  },
  'clueVoidSubmissions': {
    "sqlite": "UPDATE submissions SET points_awarded = 0,\n           evaluation_json = json_object('voided', 1, 'special', ?)\n           WHERE room_id = ? AND clue_id = ?"
  },
  'clueSubmissions': {
    "sqlite": "SELECT * FROM submissions WHERE room_id = ? AND clue_id = ? ORDER BY elapsed_ms"
  },
  'clueAppliedScores': {
    "sqlite": "SELECT player_id AS playerId, SUM(delta) AS points\n         FROM score_events\n         WHERE room_id = ? AND clue_id = ? AND source IN ('music', 'price', 'void')\n         GROUP BY player_id\n         HAVING SUM(delta) != 0"
  },
  'clueDeleteSubmissions': {
    "sqlite": "DELETE FROM submissions WHERE room_id = ? AND clue_id = ?"
  },
  'clueDeleteWagers': {
    "sqlite": "DELETE FROM final_wagers WHERE room_id = ? AND clue_id = ?"
  },
  'clueWagers': {
    "sqlite": "SELECT w.player_id, w.amount\n             FROM final_wagers w\n             JOIN players p ON p.id = w.player_id\n             WHERE w.room_id = ? AND w.clue_id = ? AND p.kicked = 0"
  },
  'clueInsertMissingFinal': {
    "sqlite": "INSERT INTO submissions\n                 (id, room_id, player_id, clue_id, answer_json, elapsed_ms, correct,\n                  points_awarded, evaluation_json, clue_prompt, clue_type, category_title)\n                 VALUES (?, ?, ?, ?, 'null', ?, 0, ?, ?, ?, ?, (\n                   SELECT title FROM categories WHERE id = ?\n                 ))"
  },
  'clueInsertSpecialSubmission': {
    "sqlite": "INSERT INTO submissions\n         (id, room_id, player_id, clue_id, answer_json, elapsed_ms, correct,\n          points_awarded, evaluation_json, clue_prompt, clue_type, category_title)\n         VALUES (?, ?, ?, ?, 'null', ?, ?, ?, ?, ?, ?, (\n           SELECT title FROM categories WHERE id = ?\n         ))"
  },
  'clueInsertMissingPenalty': {
    "sqlite": "INSERT INTO submissions\n           (id, room_id, player_id, clue_id, answer_json, elapsed_ms, correct,\n            points_awarded, evaluation_json, clue_prompt, clue_type, category_title)\n           VALUES (?, ?, ?, ?, 'null', ?, 0, ?, ?, ?, ?, (\n             SELECT title FROM categories WHERE id = ?\n           ))"
  },
  'submissionEvaluate': {
    "sqlite": "UPDATE submissions SET correct = ?, rank = ?, points_awarded = ?, evaluation_json = ?\n         WHERE id = ?"
  },
  'scoreInsert': {
    "sqlite": "INSERT INTO score_events\n         (id, room_id, player_id, clue_id, delta, source, reason, actor)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  },
  'clueGet': {
    "sqlite": "SELECT * FROM clues WHERE id = ? AND archived = 0"
  },
  'clueBelongsToPack': {
    "sqlite": "SELECT q.id FROM clues q JOIN categories c ON c.id = q.category_id\n           WHERE q.id = ? AND c.pack_id = ? AND q.archived = 0 AND c.archived = 0"
  },
  'packUnusedClues': {
    "sqlite": "SELECT q.id FROM clues q\n         JOIN categories c ON c.id = q.category_id\n         WHERE c.pack_id = ? AND q.archived = 0 AND c.archived = 0 AND q.is_final = 0"
  },
  'packFinalClue': {
    "sqlite": "SELECT q.id FROM clues q\n           JOIN categories c ON c.id = q.category_id\n           WHERE c.pack_id = ? AND q.is_final = 1 AND q.archived = 0 AND c.archived = 0\n           LIMIT 1"
  },
  'historyList': {
    "sqlite": "SELECT r.id, r.code, p.title AS packTitle, r.status, r.created_at AS createdAt,\n                r.completed_at AS completedAt, COUNT(DISTINCT pl.id) AS playerCount\n         FROM rooms r\n         JOIN packs p ON p.id = r.pack_id\n         LEFT JOIN players pl ON pl.room_id = r.id AND pl.kicked = 0\n         WHERE r.status IN ('finished', 'abandoned')\n         GROUP BY r.id\n         ORDER BY r.updated_at DESC\n         LIMIT 100"
  },
  'historyDeleteAll': {
    "sqlite": "DELETE FROM rooms WHERE status IN ('finished', 'abandoned')"
  },
  'historyDelete': {
    "sqlite": "DELETE FROM rooms WHERE id = ? AND status IN ('finished', 'abandoned')"
  },
  'historyRoomStatus': {
    "sqlite": "SELECT status FROM rooms WHERE id = ?"
  },
  'historyRoom': {
    "sqlite": "SELECT r.id, r.code, p.title AS packTitle, r.status, r.settings_json AS settings,\n                r.created_at AS createdAt, r.completed_at AS completedAt\n         FROM rooms r JOIN packs p ON p.id = r.pack_id WHERE r.id = ?"
  },
  'historyPlayers': {
    "sqlite": "SELECT p.id, p.nickname, p.team_name AS teamName, COALESCE(SUM(s.delta), 0) AS score\n         FROM players p LEFT JOIN score_events s ON s.player_id = p.id\n         WHERE p.room_id = ? GROUP BY p.id ORDER BY score DESC"
  },
  'historySubmissions': {
    "sqlite": "SELECT s.player_id AS playerId, s.clue_id AS clueId,\n                s.category_title AS categoryTitle, s.clue_prompt AS cluePrompt,\n                s.clue_type AS clueType, s.answer_json AS answer,\n                s.elapsed_ms AS elapsedMs, s.correct, s.rank,\n                s.points_awarded AS pointsAwarded, s.evaluation_json AS evaluation\n         FROM submissions s WHERE s.room_id = ? ORDER BY julianday(s.received_at)"
  },
  'historyExport': {
    "sqlite": "SELECT p.nickname, p.team_name AS team, s.category_title AS category, s.clue_prompt AS prompt,\n                s.clue_type AS type,\n                s.answer_json, s.elapsed_ms, s.correct, s.rank, s.points_awarded,\n                s.evaluation_json\n         FROM submissions s\n         JOIN players p ON p.id = s.player_id\n         WHERE s.room_id = ? ORDER BY julianday(s.received_at), p.nickname"
  },
  'settingGet': {
    "sqlite": "SELECT value FROM app_settings WHERE key = ?"
  },
  'settingSave': {
    "sqlite": "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)\n     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  }
} as const
export type StatementName = keyof typeof statements
