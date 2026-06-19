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

-- Fix: plan_progress view must exclude archived tasks from counts
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
];
