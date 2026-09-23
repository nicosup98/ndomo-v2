/**
 * ndomo memory — embedded SQLite schema (v1).
 *
 * One DB per project at <storage>/projects/<projectTag>.db. The schema is
 * intentionally standalone: it does not touch .ndomo/state.db nor any plan /
 * task tables.
 *
 * All statements are idempotent (IF NOT EXISTS / INSERT OR IGNORE) so
 * ensureMemSchema can be called on every open.
 */

import type { Database } from "bun:sqlite";

export const MEM_SCHEMA_VERSION = 1;

export const MEM_SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'note',
  project_tag TEXT NOT NULL,
  project_path TEXT,
  project_name TEXT,
  git_repo_url TEXT,
  user_name TEXT,
  user_email TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_pinned_created ON memories(is_pinned, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
`;

/**
 * Apply the v1 memory schema. Idempotent — safe to call on every DB open.
 *
 * NOTE: PRAGMA foreign_keys is NOT set here; openMemDb enables it. Keeping the
 * pragma out of this SQL lets tests apply the schema to arbitrary handles.
 */
export function ensureMemSchema(db: Database): void {
  db.exec(MEM_SCHEMA_V1_SQL);
}
