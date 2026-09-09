import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

const migrations = [
  `
    CREATE TABLE packs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'archived')),
      default_settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      position INTEGER NOT NULL,
      UNIQUE(pack_id, position)
    );

    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      duration_seconds REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE clues (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('music_multiple_choice', 'music_free_text', 'price_slider')),
      board_value INTEGER NOT NULL CHECK(board_value > 0),
      position INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      timer_seconds INTEGER NOT NULL DEFAULT 30 CHECK(timer_seconds BETWEEN 5 AND 300),
      config_json TEXT NOT NULL,
      media_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category_id, position)
    );

    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      pack_id TEXT NOT NULL REFERENCES packs(id),
      host_token_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('lobby', 'active', 'paused', 'finished', 'abandoned')),
      settings_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 1,
      joining_locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE TABLE players (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      reconnect_token_hash TEXT NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0,
      kicked INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX players_room_nickname_ci
      ON players(room_id, lower(nickname));

    CREATE TABLE submissions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      clue_id TEXT NOT NULL REFERENCES clues(id),
      answer_json TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
      correct INTEGER,
      rank INTEGER,
      points_awarded INTEGER,
      evaluation_json TEXT,
      UNIQUE(room_id, player_id, clue_id)
    );

    CREATE TABLE score_events (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      clue_id TEXT REFERENCES clues(id),
      delta INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('music', 'price', 'host_adjustment', 'void')),
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE game_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      state_version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, state_version)
    );

    CREATE INDEX categories_pack_position ON categories(pack_id, position);
    CREATE INDEX clues_category_position ON clues(category_id, position);
    CREATE INDEX rooms_status_updated ON rooms(status, updated_at);
    CREATE INDEX players_room ON players(room_id);
    CREATE INDEX submissions_room_clue ON submissions(room_id, clue_id);
    CREATE INDEX score_events_room_player ON score_events(room_id, player_id);
    CREATE INDEX snapshots_room_version ON game_snapshots(room_id, state_version DESC);
  `,
  `
    ALTER TABLE categories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE clues ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX categories_pack_active_position
      ON categories(pack_id, archived, position);
    CREATE INDEX clues_category_active_position
      ON clues(category_id, archived, position);
  `,
  `
    ALTER TABLE submissions ADD COLUMN clue_prompt TEXT NOT NULL DEFAULT '';
    ALTER TABLE submissions ADD COLUMN clue_type TEXT NOT NULL DEFAULT '';
    ALTER TABLE submissions ADD COLUMN category_title TEXT NOT NULL DEFAULT '';

    UPDATE submissions
    SET clue_prompt = COALESCE((SELECT prompt FROM clues WHERE clues.id = submissions.clue_id), ''),
        clue_type = COALESCE((SELECT type FROM clues WHERE clues.id = submissions.clue_id), ''),
        category_title = COALESCE((
          SELECT categories.title
          FROM clues
          JOIN categories ON categories.id = clues.category_id
          WHERE clues.id = submissions.clue_id
        ), '');
  `,
  `
    CREATE TABLE final_wagers (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      clue_id TEXT NOT NULL REFERENCES clues(id),
      amount INTEGER NOT NULL CHECK(amount >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(room_id, player_id, clue_id)
    );

    CREATE INDEX final_wagers_room_clue ON final_wagers(room_id, clue_id);
  `,
  `
    ALTER TABLE clues ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX clues_final ON clues(is_final, archived);
  `,
  `
    ALTER TABLE clues ADD COLUMN reveal_media_asset_id TEXT
      REFERENCES media_assets(id) ON DELETE SET NULL;
  `,
  `
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `,
  `
    ALTER TABLE players ADD COLUMN team_name TEXT;
  `,
] as const

export function openDatabase(databasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = new Database(databasePath)

  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')

  const currentVersion = database.pragma('user_version', { simple: true }) as number
  for (let index = currentVersion; index < migrations.length; index += 1) {
    const migration = migrations[index]
    if (!migration) {
      throw new Error(`Missing database migration ${index + 1}`)
    }

    database.transaction(() => {
      database.exec(migration)
      database.pragma(`user_version = ${index + 1}`)
    })()
  }

  return database
}
