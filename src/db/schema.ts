/**
 * ndomo DB — DDL schema definitions and migration registry.
 *
 * Uses IF NOT EXISTS everywhere for idempotency.
 * FTS5 virtual tables are auto-synced via triggers.
 */

export const SCHEMA_V1_SQL = `
-- schema_version table
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);

-- plans table
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','approved','executing','completed','failed','abandoned')),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_at INTEGER,
  completed_at INTEGER,
  session_id TEXT,
  overview TEXT NOT NULL,
  approach TEXT,
  complexity INTEGER NOT NULL DEFAULT 3 CHECK(complexity BETWEEN 1 AND 5),
  metadata JSON
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);
CREATE INDEX IF NOT EXISTS idx_plans_created ON plans(created_at DESC);

-- plan_tasks table
CREATE TABLE IF NOT EXISTS plan_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  description TEXT NOT NULL,
  agent TEXT NOT NULL,
  files JSON NOT NULL DEFAULT '[]',
  complexity INTEGER NOT NULL DEFAULT 3 CHECK(complexity BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','blocked')),
  started_at INTEGER,
  completed_at INTEGER,
  result TEXT,
  error TEXT,
  dependencies JSON DEFAULT '[]',
  metadata JSON,
  UNIQUE(plan_id, order_index)
);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON plan_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON plan_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON plan_tasks(agent);

-- sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_checkpoint INTEGER,
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  goal TEXT NOT NULL,
  state JSON NOT NULL DEFAULT '{}',
  agent_history JSON NOT NULL DEFAULT '[]',
  key_decisions TEXT,
  metadata JSON
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_plan ON sessions(plan_id);

-- FTS5 for plans
CREATE VIRTUAL TABLE IF NOT EXISTS plans_fts USING fts5(
  id UNINDEXED, title, overview, approach,
  content='plans', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS plans_ai AFTER INSERT ON plans BEGIN
  INSERT INTO plans_fts(rowid, id, title, overview, approach)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach);
END;
CREATE TRIGGER IF NOT EXISTS plans_ad AFTER DELETE ON plans BEGIN
  INSERT INTO plans_fts(plans_fts, rowid, id, title, overview, approach)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach);
END;
CREATE TRIGGER IF NOT EXISTS plans_au AFTER UPDATE ON plans BEGIN
  INSERT INTO plans_fts(plans_fts, rowid, id, title, overview, approach)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach);
  INSERT INTO plans_fts(rowid, id, title, overview, approach)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach);
END;

-- FTS5 for plan_tasks
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  id UNINDEXED, description, result, error,
  content='plan_tasks', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON plan_tasks BEGIN
  INSERT INTO tasks_fts(rowid, id, description, result, error)
  VALUES (new.rowid, new.id, new.description, COALESCE(new.result,''), COALESCE(new.error,''));
END;
CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON plan_tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, id, description, result, error)
  VALUES ('delete', old.rowid, old.id, old.description, COALESCE(old.result,''), COALESCE(old.error,''));
END;
CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON plan_tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, id, description, result, error)
  VALUES ('delete', old.rowid, old.id, old.description, COALESCE(old.result,''), COALESCE(old.error,''));
  INSERT INTO tasks_fts(rowid, id, description, result, error)
  VALUES (new.rowid, new.id, new.description, COALESCE(new.result,''), COALESCE(new.error,''));
END;
`;

export const SCHEMA_V2_SQL = `
-- v2: discriminated metadata + audit + tags
-- (idempotente: ADD COLUMN con default, IF NOT EXISTS en tablas/triggers)

-- plans: audit + source
ALTER TABLE plans ADD COLUMN created_by TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE plans ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE plans ADD COLUMN source_session_id TEXT;
ALTER TABLE plans ADD COLUMN source_message_id TEXT;
ALTER TABLE plans ADD COLUMN category TEXT CHECK(category IN ('feature','refactor','bugfix','docs','infra'));

-- plan_tasks: audit + source + metrics
ALTER TABLE plan_tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE plan_tasks ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE plan_tasks ADD COLUMN source_session_id TEXT;
ALTER TABLE plan_tasks ADD COLUMN source_message_id TEXT;
ALTER TABLE plan_tasks ADD COLUMN reviewed_by TEXT;
ALTER TABLE plan_tasks ADD COLUMN tokens_used INTEGER;
ALTER TABLE plan_tasks ADD COLUMN duration_ms INTEGER;
ALTER TABLE plan_tasks ADD COLUMN artifacts JSON DEFAULT '[]';

-- sessions: audit + parent link + outcome
ALTER TABLE sessions ADD COLUMN created_by TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE sessions ADD COLUMN source_message_id TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN outcome TEXT CHECK(outcome IN ('success','partial','failed','abandoned'));

-- plan_tags M:N
CREATE TABLE IF NOT EXISTS plan_tags (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_plan_tags_tag ON plan_tags(tag);

-- task_tags M:N
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag);

-- FTS5 ampliado: incluir category de plans y desnormalizar tags via trigger
CREATE VIRTUAL TABLE IF NOT EXISTS plans_fts_v2 USING fts5(
  id UNINDEXED, title, overview, approach, category, tags,
  content='', tokenize='porter unicode61'
);
-- Triggers para mantener plans_fts_v2 sincronizado
CREATE TRIGGER IF NOT EXISTS plans_v2_ai AFTER INSERT ON plans BEGIN
  INSERT INTO plans_fts_v2(rowid, id, title, overview, approach, category, tags)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach, new.category, '');
END;
CREATE TRIGGER IF NOT EXISTS plans_v2_au AFTER UPDATE ON plans BEGIN
  INSERT INTO plans_fts_v2(plans_fts_v2, rowid, id, title, overview, approach, category, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach, old.category, '');
  INSERT INTO plans_fts_v2(rowid, id, title, overview, approach, category, tags)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach, new.category, '');
END;
CREATE TRIGGER IF NOT EXISTS plans_v2_ad AFTER DELETE ON plans BEGIN
  INSERT INTO plans_fts_v2(plans_fts_v2, rowid, id, title, overview, approach, category, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach, old.category, '');
END;
`;

export const SCHEMA_V3_SQL = `
-- v3: fix 4 audit observations (1 high, 3 medium)
-- Fix #9: updated_at auto-trigger (OF columns, no recursion)
-- Fix #2: metadata DEFAULT '{}' (ALTER COLUMN may fail on older SQLite — mapper fallback exists)
-- Fix #14: composite indexes for common query patterns
-- Fix #1 + #8: session_id FK validated at app level (see plans.ts)

-- Fix #2: metadata DEFAULT '{}' — ALTER COLUMN SET DEFAULT is NOT supported
-- in bun:sqlite 1.3.14 (SQLite 3.45.1). The mapper in types.ts already handles
-- null/undefined metadata with ?? '{}' so the data layer is safe either way.
-- If a future bun version supports this, uncomment these lines:
-- ALTER TABLE plans ALTER COLUMN metadata SET DEFAULT '{}';
-- ALTER TABLE plan_tasks ALTER COLUMN metadata SET DEFAULT '{}';
-- ALTER TABLE sessions ALTER COLUMN metadata SET DEFAULT '{}';

-- Fix #9: updated_at auto-update via BEFORE UPDATE OF <column_list>.
-- The OF clause lists only "editable" columns, excluding updated_at itself
-- and immutable columns (id, created_at). This guarantees no recursion loop.
-- Sessions use last_checkpoint instead of updated_at (semantic: each UPDATE = checkpoint).
CREATE TRIGGER IF NOT EXISTS trg_plans_updated_at_bu
BEFORE UPDATE OF title, status, priority, overview, approach, complexity, category, updated_by, metadata ON plans
BEGIN
  UPDATE plans SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at_bu
BEFORE UPDATE OF description, agent, files, complexity, status, updated_by, artifacts, metadata ON plan_tasks
BEGIN
  UPDATE plan_tasks SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_updated_at_bu
BEFORE UPDATE OF goal, state, agent_history, key_decisions, outcome, ended_at, metadata ON sessions
BEGIN
  UPDATE sessions SET last_checkpoint = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE rowid = NEW.rowid;
END;

-- Fix #14: composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_plans_status_priority ON plans(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_plan_status ON plan_tasks(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON plan_tasks(agent, status);
`;

export const SCHEMA_V4_SQL = `
-- v4: 5 schema fixes + 1 code fix (6 low-priority observations)

-- ── Fix 1: plans.priority CHECK(1-4) via trigger ────────────────────────────
-- SQLite lacks ALTER TABLE ADD CONSTRAINT; use BEFORE INSERT/UPDATE trigger.

-- ── Pre-fix: drop broken v3 trigger (references non-existent updated_at on plan_tasks)
DROP TRIGGER IF EXISTS trg_tasks_updated_at_bu;

DROP TRIGGER IF EXISTS trg_plans_priority_check;
CREATE TRIGGER trg_plans_priority_check
BEFORE INSERT ON plans
BEGIN
  SELECT RAISE(ABORT, 'ndomo: priority must be 1-4')
  WHERE NEW.priority NOT BETWEEN 1 AND 4;
END;

DROP TRIGGER IF EXISTS trg_plans_priority_check_u;
CREATE TRIGGER trg_plans_priority_check_u
BEFORE UPDATE OF priority ON plans
BEGIN
  SELECT RAISE(ABORT, 'ndomo: priority must be 1-4')
  WHERE NEW.priority NOT BETWEEN 1 AND 4;
END;

-- ── Fix 2: plans.slug format validation (kebab-case) ────────────────────────
DROP TRIGGER IF EXISTS trg_plans_slug_check;
CREATE TRIGGER trg_plans_slug_check
BEFORE INSERT ON plans
BEGIN
  SELECT RAISE(ABORT, 'ndomo: slug must be kebab-case 1-60 chars [a-z0-9]+(-[a-z0-9]+)*')
  WHERE NEW.slug NOT GLOB '[a-z0-9]*'
     OR NEW.slug GLOB '*--*'
     OR NEW.slug GLOB '*-'
     OR length(NEW.slug) = 0
     OR length(NEW.slug) > 60
     OR NEW.slug GLOB '*[^a-z0-9-]*';
END;

DROP TRIGGER IF EXISTS trg_plans_slug_check_u;
CREATE TRIGGER trg_plans_slug_check_u
BEFORE UPDATE OF slug ON plans
BEGIN
  SELECT RAISE(ABORT, 'ndomo: slug must be kebab-case 1-60 chars [a-z0-9]+(-[a-z0-9]+)*')
  WHERE NEW.slug NOT GLOB '[a-z0-9]*'
     OR NEW.slug GLOB '*--*'
     OR NEW.slug GLOB '*-'
     OR length(NEW.slug) = 0
     OR length(NEW.slug) > 60
     OR NEW.slug GLOB '*[^a-z0-9-]*';
END;

-- ── Fix 3: plan_progress view ───────────────────────────────────────────────
DROP VIEW IF EXISTS plan_progress;
CREATE VIEW plan_progress AS
SELECT
  p.id AS plan_id,
  p.slug,
  p.title,
  p.status,
  COUNT(t.id) AS total_tasks,
  SUM(CASE WHEN t.status = 'done'     THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN t.status = 'failed'   THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN t.status = 'running'  THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN t.status = 'pending'  THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN t.status = 'blocked'  THEN 1 ELSE 0 END) AS blocked,
  CASE
    WHEN COUNT(t.id) = 0 THEN 0
    ELSE ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id))
  END AS progress_pct
FROM plans p
LEFT JOIN plan_tasks t ON t.plan_id = p.id
GROUP BY p.id;

-- ── Fix 4: FTS5 — unicode61 remove_diacritics 1 + spanish stopwords ────────
-- Drop legacy v1 FTS (content-synced, superseded by v2)
DROP TRIGGER IF EXISTS plans_ai;
DROP TRIGGER IF EXISTS plans_ad;
DROP TRIGGER IF EXISTS plans_au;
DROP TABLE IF EXISTS plans_fts;

-- Drop tasks_fts + sync triggers (v1, will recreate with new tokenizer)
DROP TRIGGER IF EXISTS tasks_ai;
DROP TRIGGER IF EXISTS tasks_ad;
DROP TRIGGER IF EXISTS tasks_au;
DROP TABLE IF EXISTS tasks_fts;

-- Drop plans_fts_v2 + sync triggers (v2, will recreate with new tokenizer)
DROP TRIGGER IF EXISTS plans_v2_ai;
DROP TRIGGER IF EXISTS plans_v2_au;
DROP TRIGGER IF EXISTS plans_v2_ad;
DROP TABLE IF EXISTS plans_fts_v2;

-- Recreate plans_fts_v2: unicode61 with diacritics removal (no Porter stemmer)
CREATE VIRTUAL TABLE plans_fts_v2 USING fts5(
  id UNINDEXED, title, overview, approach, category, tags,
  content='', tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER plans_v2_ai AFTER INSERT ON plans BEGIN
  INSERT INTO plans_fts_v2(rowid, id, title, overview, approach, category, tags)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach, new.category, '');
END;
CREATE TRIGGER plans_v2_ad AFTER DELETE ON plans BEGIN
  INSERT INTO plans_fts_v2(plans_fts_v2, rowid, id, title, overview, approach, category, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach, old.category, '');
END;
CREATE TRIGGER plans_v2_au AFTER UPDATE ON plans BEGIN
  INSERT INTO plans_fts_v2(plans_fts_v2, rowid, id, title, overview, approach, category, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach, old.category, '');
  INSERT INTO plans_fts_v2(rowid, id, title, overview, approach, category, tags)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach, new.category, '');
END;

-- Recreate tasks_fts: unicode61 with diacritics removal (no Porter stemmer)
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  id UNINDEXED, description, result, error,
  content='plan_tasks', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER tasks_ai AFTER INSERT ON plan_tasks BEGIN
  INSERT INTO tasks_fts(rowid, id, description, result, error)
  VALUES (new.rowid, new.id, new.description, COALESCE(new.result, ''), COALESCE(new.error, ''));
END;
CREATE TRIGGER tasks_ad AFTER DELETE ON plan_tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, id, description, result, error)
  VALUES ('delete', old.rowid, old.id, old.description, COALESCE(old.result, ''), COALESCE(old.error, ''));
END;
CREATE TRIGGER tasks_au AFTER UPDATE ON plan_tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, id, description, result, error)
  VALUES ('delete', old.rowid, old.id, old.description, COALESCE(old.result, ''), COALESCE(old.error, ''));
  INSERT INTO tasks_fts(rowid, id, description, result, error)
  VALUES (new.rowid, new.id, new.description, COALESCE(new.result, ''), COALESCE(new.error, ''));
END;

-- Rebuild FTS indexes from content tables
INSERT INTO plans_fts_v2(plans_fts_v2) VALUES ('rebuild');
INSERT INTO tasks_fts(tasks_fts) VALUES ('rebuild');

-- Spanish stopwords (common function words, not indexed by FTS)
-- NOTE: fts5_stopwords table is populated but NOT referenced by the
-- unicode61 tokenizer (which doesn't support custom stopwords tables).
-- Table is kept for future use if a custom tokenizer is added. See FINDING-2.
CREATE TABLE IF NOT EXISTS fts5_stopwords(value TEXT PRIMARY KEY);
INSERT OR IGNORE INTO fts5_stopwords(value) VALUES
  ('el'),('la'),('de'),('que'),('y'),('a'),('en'),('un'),('ser'),('se'),
  ('no'),('haber'),('por'),('con'),('su'),('para'),('como'),('estar'),
  ('tener'),('le'),('lo'),('todo'),('pero'),('más'),('hacer'),('sobre'),
  ('sin'),('año'),('día'),('vez'),('sí'),('porque'),('esta'),('entre'),
  ('cuando'),('muy'),('tras'),('hasta'),('donde'),('desde'),('todos'),
  ('también'),('otro'),('ese'),('eso'),('ante'),('ellos'),
  ('e'),('esto'),('antes'),('algunos'),('qué'),('unos'),('yo'),('otra'),
  ('otras'),('otros'),('cual'),('si'),('mi'),('tú'),('te');

-- ── Fix 6: plan_tasks.metadata DEFAULT '{}' via trigger ─────────────────────
-- BEFORE triggers cannot modify NEW in SQLite. AFTER INSERT is safe because
-- createTasksBatch already passes metadata=??{}, so this is purely defensive
-- for direct SQL inserts or future callers that omit metadata.
DROP TRIGGER IF EXISTS trg_tasks_metadata_default;
CREATE TRIGGER trg_tasks_metadata_default
AFTER INSERT ON plan_tasks
WHEN NEW.metadata IS NULL
BEGIN
  UPDATE plan_tasks SET metadata = '{}' WHERE rowid = NEW.rowid;
END;
`;

/**
 * v5: soft delete via archived_at + composite indexes.
 *
 * The ALTER TABLE ADD COLUMN statements are executed by migrations.ts
 * (addColumnIfMissing) because SQLite 3.45 lacks IF NOT EXISTS for columns.
 * This SQL only contains the CREATE INDEX statements which are idempotent.
 */
export const SCHEMA_V5_SQL = `
-- v5: soft delete — archived_at columns + indexes
-- Columns added via addColumnIfMissing() in migrations.ts (idempotent ALTER TABLE)
CREATE INDEX IF NOT EXISTS idx_plans_archived ON plans(archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON plan_tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived_at);

-- Fix: plan_progress view must exclude archived plans AND archived tasks from counts
DROP VIEW IF EXISTS plan_progress;
CREATE VIEW plan_progress AS
SELECT
  p.id AS plan_id,
  p.slug,
  p.title,
  p.status,
  COUNT(t.id) AS total_tasks,
  SUM(CASE WHEN t.status = 'done'     THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN t.status = 'failed'   THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN t.status = 'running'  THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN t.status = 'pending'  THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN t.status = 'blocked'  THEN 1 ELSE 0 END) AS blocked,
  CASE
    WHEN COUNT(t.id) = 0 THEN 0
    ELSE ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id))
  END AS progress_pct
FROM plans p
LEFT JOIN plan_tasks t ON t.plan_id = p.id AND t.archived_at IS NULL
WHERE p.archived_at IS NULL
GROUP BY p.id;

-- Fix: plans_fts_v2 was contentless (content='') — columns return NULL on SELECT,
-- breaking searchPlans JOIN/subquery. Switch to external content (content='plans')
-- so column values are readable via the content table.
DROP TRIGGER IF EXISTS plans_v2_ai;
DROP TRIGGER IF EXISTS plans_v2_ad;
DROP TRIGGER IF EXISTS plans_v2_au;
DROP TABLE IF EXISTS plans_fts_v2;

CREATE VIRTUAL TABLE plans_fts_v2 USING fts5(
  id UNINDEXED, title, overview, approach, category,
  content='plans', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER plans_v2_ai AFTER INSERT ON plans BEGIN
  INSERT INTO plans_fts_v2(rowid, id, title, overview, approach, category)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach, new.category);
END;
CREATE TRIGGER plans_v2_ad AFTER DELETE ON plans BEGIN
  INSERT INTO plans_fts_v2(plans_fts_v2, rowid, id, title, overview, approach, category)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach, old.category);
END;
CREATE TRIGGER plans_v2_au AFTER UPDATE ON plans BEGIN
  INSERT INTO plans_fts_v2(plans_fts_v2, rowid, id, title, overview, approach, category)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach, old.category);
  INSERT INTO plans_fts_v2(rowid, id, title, overview, approach, category)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach, new.category);
END;

-- Rebuild FTS index from content table
INSERT INTO plans_fts_v2(plans_fts_v2) VALUES ('rebuild');
`;

/**
 * v6: write-once audit trail — original_plan_data on plans + plan_tasks.
 *
 * Columns added via addColumnIfMissing() in migrations.ts (idempotent ALTER TABLE).
 * This SQL is intentionally empty — all DDL is in migrations.ts for this version.
 */
export const SCHEMA_V6_SQL =
  "-- v6: original_plan_data columns added via addColumnIfMissing in migrations.ts";

/**
 * v7: plan_files join table — M:N relationship between plans and files.
 *
 * Tracks which files are associated with a plan and their role (e.g., 'input', 'output', 'reference').
 */
export const SCHEMA_V7_SQL = `
CREATE TABLE IF NOT EXISTS plan_files (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'input',
  PRIMARY KEY (plan_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_plan_files_plan ON plan_files(plan_id);
`;

/**
 * v8: agent execution tracking — created_by_agent, executed_by_agent, executed_by_session.
 *
 * Columns added via addColumnIfMissing() in migrations.ts (idempotent ALTER TABLE).
 * executed_by_session is a FK to sessions(id) validated at app level.
 * This SQL is intentionally empty — all DDL is in migrations.ts for this version.
 */
export const SCHEMA_V8_SQL =
  "-- v8: agent tracking columns added via addColumnIfMissing in migrations.ts";

/**
 * v9: plan_progress view fix — exclude archived plans.
 *
 * DBs that already had schema_version >= 5 when the fix landed in v5
 * never re-ran v5, so they still have the old view without archived_at filters.
 * This migration recreates the view unconditionally (DROP + CREATE).
 */
export const SCHEMA_V9_SQL = `
DROP VIEW IF EXISTS plan_progress;
CREATE VIEW plan_progress AS
SELECT
  p.id AS plan_id,
  p.slug,
  p.title,
  p.status,
  COUNT(t.id) AS total_tasks,
  SUM(CASE WHEN t.status = 'done'     THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN t.status = 'failed'   THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN t.status = 'running'  THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN t.status = 'pending'  THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN t.status = 'blocked'  THEN 1 ELSE 0 END) AS blocked,
  CASE
    WHEN COUNT(t.id) = 0 THEN 0
    ELSE ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id))
  END AS progress_pct
FROM plans p
LEFT JOIN plan_tasks t ON t.plan_id = p.id AND t.archived_at IS NULL
WHERE p.archived_at IS NULL
GROUP BY p.id;
`;

/**
 * v10: plan_files multi-role PK + created_at.
 *
 * Changes PK from (plan_id, file_path) to (plan_id, file_path, role)
 * so the same file can have multiple roles (input + modified + reviewed).
 * Also adds created_at column for ordering/auditing.
 *
 * Safe migration: recreate table (SQLite cannot ALTER PK directly).
 */
export const SCHEMA_V10_SQL = `
-- v10: plan_files multi-role PK + created_at
CREATE TABLE IF NOT EXISTS plan_files_new (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'input',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  PRIMARY KEY (plan_id, file_path, role)
);
INSERT INTO plan_files_new (plan_id, file_path, role, created_at)
  SELECT plan_id, file_path, role, strftime('%s','now') * 1000 FROM plan_files;
DROP TABLE plan_files;
ALTER TABLE plan_files_new RENAME TO plan_files;
CREATE INDEX IF NOT EXISTS idx_plan_files_plan ON plan_files(plan_id);
`;

export const SCHEMA_V11_SQL = `
CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
  session_id TEXT,
  result TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  files TEXT,
  worktree TEXT
);
CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status);
CREATE INDEX IF NOT EXISTS idx_background_tasks_agent ON background_tasks(agent);
`;

/**
 * v12: DB optimization — plan_progress views, composite indexes, plan_audit skeleton.
 *
 * (1) plan_progress_active + plan_progress_historical views (P1 fix)
 * (2) Replace idx_plans_status_priority with idx_plans_listplans (P1.5)
 * (3) Consolidate plan_tasks indexes — drop redundant single-column indexes (P3)
 * (4) Add composite indexes on background_tasks (P2)
 * (5) plan_audit table skeleton for future audit trail (P4 foundation)
 */
export const SCHEMA_V12_SQL = `
-- v12: plan_progress views (explicit active + historical) + index optimization + plan_audit skeleton

-- P1: plan_progress_active (explicit name, same as current plan_progress)
DROP VIEW IF EXISTS plan_progress;
DROP VIEW IF EXISTS plan_progress_active;
DROP VIEW IF EXISTS plan_progress_historical;

CREATE VIEW plan_progress_active AS
SELECT
  p.id AS plan_id,
  p.slug,
  p.title,
  p.status,
  COUNT(t.id) AS total_tasks,
  SUM(CASE WHEN t.status = 'done'     THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN t.status = 'failed'   THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN t.status = 'running'  THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN t.status = 'pending'  THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN t.status = 'blocked'  THEN 1 ELSE 0 END) AS blocked,
  CASE
    WHEN COUNT(t.id) = 0 THEN 0
    ELSE ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id))
  END AS progress_pct
FROM plans p
LEFT JOIN plan_tasks t ON t.plan_id = p.id AND t.archived_at IS NULL
WHERE p.archived_at IS NULL
GROUP BY p.id;

-- P1: plan_progress_historical (ALL plans, ALL tasks)
CREATE VIEW plan_progress_historical AS
SELECT
  p.id AS plan_id,
  p.slug,
  p.title,
  p.status,
  COUNT(t.id) AS total_tasks,
  SUM(CASE WHEN t.status = 'done'     THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN t.status = 'failed'   THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN t.status = 'running'  THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN t.status = 'pending'  THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN t.status = 'blocked'  THEN 1 ELSE 0 END) AS blocked,
  CASE
    WHEN COUNT(t.id) = 0 THEN 0
    ELSE ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id))
  END AS progress_pct
FROM plans p
LEFT JOIN plan_tasks t ON t.plan_id = p.id
GROUP BY p.id;

-- Backward compat: plan_progress = plan_progress_active
CREATE VIEW plan_progress AS
SELECT * FROM plan_progress_active;

-- P1.5: replace idx_plans_status_priority with composite matching listPlans query
DROP INDEX IF EXISTS idx_plans_status_priority;
CREATE INDEX IF NOT EXISTS idx_plans_listplans ON plans(status, archived_at, priority, created_at DESC);

-- P3: consolidate plan_tasks indexes — drop redundant single-column indexes
DROP INDEX IF EXISTS idx_tasks_status;
DROP INDEX IF EXISTS idx_tasks_agent;
DROP INDEX IF EXISTS idx_tasks_archived;

-- P2: background_tasks composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_background_tasks_agent_created ON background_tasks(agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_background_tasks_created ON background_tasks(created_at DESC);

-- P4 foundation: plan_audit table skeleton
CREATE TABLE IF NOT EXISTS plan_audit (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  snapshot TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'archive',
  PRIMARY KEY(plan_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_plan_audit_captured ON plan_audit(captured_at DESC);
`;

// ── v13: ops tables ─────────────────────────────────────────────────────────

export const SCHEMA_V13_SQL = `
-- v13: ops tables (environments, releases, deployments, incidents, rollback_executions)

-- environments: named deployment targets (e.g. "prod", "staging", "dev")
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  metadata JSON,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_environments_slug ON environments(slug);
CREATE INDEX IF NOT EXISTS idx_environments_archived ON environments(archived_at);

-- releases: versioned artifacts that can be deployed
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  metadata JSON,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK(version <> '')
);
CREATE INDEX IF NOT EXISTS idx_releases_version ON releases(version);
CREATE INDEX IF NOT EXISTS idx_releases_created ON releases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_releases_archived ON releases(archived_at);

-- deployments: a release deployed to an environment at a point in time
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','succeeded','failed','rolled_back')),
  deployed_at INTEGER,
  created_at INTEGER NOT NULL,
  metadata JSON,
  CHECK(release_id <> ''),
  CHECK(environment_id <> '')
);
CREATE INDEX IF NOT EXISTS idx_deployments_release ON deployments(release_id);
CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployments(environment_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_deployed ON deployments(deployed_at DESC);

-- incidents: operational events, optionally linked to a triggering deployment
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(title <> ''),
  severity TEXT NOT NULL CHECK(severity IN ('sev1','sev2','sev3','sev4')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','triaging','mitigated','resolved','postmortem')),
  summary TEXT,
  triggered_by_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  metadata JSON
);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_deployment ON incidents(triggered_by_deployment_id);

-- rollback_executions: record of a rollback action, optionally tied to an incident
CREATE TABLE IF NOT EXISTS rollback_executions (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
  incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
  new_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','approved','dry_run','executing','success','failed','cancelled')),
  plan TEXT NOT NULL,
  executed_at INTEGER,
  created_at INTEGER NOT NULL,
  metadata JSON,
  CHECK(deployment_id <> ''),
  CHECK(plan <> '')
);
CREATE INDEX IF NOT EXISTS idx_rollbacks_deployment ON rollback_executions(deployment_id);
CREATE INDEX IF NOT EXISTS idx_rollbacks_incident ON rollback_executions(incident_id);
CREATE INDEX IF NOT EXISTS idx_rollbacks_new_deployment ON rollback_executions(new_deployment_id);
CREATE INDEX IF NOT EXISTS idx_rollbacks_status ON rollback_executions(status);
CREATE INDEX IF NOT EXISTS idx_rollbacks_created ON rollback_executions(created_at DESC);
`;

// ── v14: analyses table ─────────────────────────────────────────────────────

export const SCHEMA_V14_SQL = `
-- v14: standalone analyses table (linkable to plans)
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  project_path TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  findings_json TEXT NOT NULL DEFAULT '[]',
  source_plan_id TEXT,
  agent TEXT NOT NULL DEFAULT 'ranger',
  session_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (source_plan_id) REFERENCES plans(id) ON DELETE SET NULL,
  UNIQUE (slug, project_path)
);

CREATE INDEX IF NOT EXISTS idx_analyses_slug ON analyses(slug);
CREATE INDEX IF NOT EXISTS idx_analyses_project ON analyses(project_path);
CREATE INDEX IF NOT EXISTS idx_analyses_archived ON analyses(archived_at);
CREATE INDEX IF NOT EXISTS idx_analyses_source_plan ON analyses(source_plan_id);
CREATE INDEX IF NOT EXISTS idx_analyses_agent ON analyses(agent);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS analyses_fts USING fts5(
  title,
  summary,
  findings_json,
  content='analyses',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);

-- Sync triggers: keep analyses_fts in sync with analyses
CREATE TRIGGER IF NOT EXISTS analyses_ai AFTER INSERT ON analyses BEGIN
  INSERT INTO analyses_fts(rowid, title, summary, findings_json)
  VALUES (new.rowid, new.title, new.summary, new.findings_json);
END;

CREATE TRIGGER IF NOT EXISTS analyses_ad AFTER DELETE ON analyses BEGIN
  INSERT INTO analyses_fts(analyses_fts, rowid, title, summary, findings_json)
  VALUES ('delete', old.rowid, old.title, old.summary, old.findings_json);
END;

CREATE TRIGGER IF NOT EXISTS analyses_au AFTER UPDATE ON analyses BEGIN
  INSERT INTO analyses_fts(analyses_fts, rowid, title, summary, findings_json)
  VALUES ('delete', old.rowid, old.title, old.summary, old.findings_json);
  INSERT INTO analyses_fts(rowid, title, summary, findings_json)
  VALUES (new.rowid, new.title, new.summary, new.findings_json);
END;
`;

export const MIGRATIONS: Array<{
  version: number;
  description: string;
  sql: string;
}> = [
  {
    version: 1,
    description: "initial schema: plans + plan_tasks + sessions + FTS5",
    sql: SCHEMA_V1_SQL,
  },
  {
    version: 2,
    description: "discriminated metadata + audit columns + M:N tags + FTS5 v2",
    sql: SCHEMA_V2_SQL,
  },
  {
    version: 3,
    description:
      "audit fixes: updated_at triggers, metadata defaults, composite indexes, session FK validation",
    sql: SCHEMA_V3_SQL,
  },
  {
    version: 4,
    description:
      "v4 low-priority fixes: priority/slug validation, plan_progress view, FTS5 diacritics, metadata default trigger",
    sql: SCHEMA_V4_SQL,
  },
  {
    version: 5,
    description: "soft delete: archived_at columns on plans/tasks/sessions + composite indexes",
    sql: SCHEMA_V5_SQL,
  },
  {
    version: 6,
    description: "write-once audit trail: original_plan_data on plans + plan_tasks",
    sql: SCHEMA_V6_SQL,
  },
  {
    version: 7,
    description: "plan_files join table: M:N plans-files with role",
    sql: SCHEMA_V7_SQL,
  },
  {
    version: 8,
    description:
      "agent execution tracking: created_by_agent, executed_by_agent, executed_by_session on plans",
    sql: SCHEMA_V8_SQL,
  },
  {
    version: 9,
    description: "plan_progress view fix: exclude archived plans from progress view",
    sql: SCHEMA_V9_SQL,
  },
  {
    version: 10,
    description: "plan_files multi-role PK: (plan_id, file_path, role) + created_at column",
    sql: SCHEMA_V10_SQL,
  },
  {
    version: 11,
    description: "background_tasks table for DB-backed task dispatch persistence",
    sql: SCHEMA_V11_SQL,
  },
  {
    version: 12,
    description: "DB optimization: plan_progress views, composite indexes, plan_audit skeleton",
    sql: SCHEMA_V12_SQL,
  },
  {
    version: 13,
    description: "ops tables: environments, releases, deployments, incidents, rollback_executions",
    sql: SCHEMA_V13_SQL,
  },
  {
    version: 14,
    description: "analyses table + FTS5 (standalone, linkable to plans)",
    sql: SCHEMA_V14_SQL,
  },
];
