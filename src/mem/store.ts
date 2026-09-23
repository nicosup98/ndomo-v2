/**
 * ndomo memory — embedded SQLite store.
 *
 * One DB per project: <storage>/projects/<projectTag>.db. All operations are
 * synchronous (bun:sqlite) and take the Database handle as their first
 * argument, mirroring the src/db/*.ts convention.
 *
 * Determinism lives here: dedup by exact content hash (UNIQUE), tag
 * normalization, JSON metadata parsing. Ranking (FlexSearch) is a separate
 * concern layered on top.
 */

import type { SQLQueryBindings } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensureMemSchema } from "./schema.ts";

export type MemIdentity = {
  projectTag: string;
  projectPath?: string | null;
  projectName?: string | null;
  gitRepoUrl?: string | null;
  userName?: string | null;
  userEmail?: string | null;
};

export type MemRecord = {
  id: string;
  content: string;
  type: string;
  tags: string[];
  projectTag: string;
  projectPath: string | null;
  projectName: string | null;
  gitRepoUrl: string | null;
  userName: string | null;
  userEmail: string | null;
  contentHash: string;
  isPinned: boolean;
  source: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown> | null;
};

export type AddMemoryInput = {
  content: string;
  type?: string;
  tags?: string[];
  pinned?: boolean;
  metadata?: Record<string, unknown>;
  source?: string;
  identity: MemIdentity;
};

export type ListMemoriesOptions = {
  type?: string;
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
};

export type MemStats = {
  total: number;
  byType: Record<string, number>;
  byTag: Record<string, number>;
  pinned: number;
  oldest: number | null;
  newest: number | null;
};

type MemoryRow = {
  id: string;
  content: string;
  type: string;
  project_tag: string;
  project_path: string | null;
  project_name: string | null;
  git_repo_url: string | null;
  user_name: string | null;
  user_email: string | null;
  content_hash: string;
  is_pinned: number;
  source: string;
  created_at: number;
  updated_at: number;
  metadata: string | null;
};

/** Full 64-char sha256 hex digest — used as the exact-dedup content hash. */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Expand a leading `~` / `~/` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Open (creating if needed) the memory DB for a project and apply pragmas +
 * schema.
 *
 * Pragma order matters: auto_vacuum must be set BEFORE journal_mode = WAL, or
 * SQLite silently ignores it on a fresh DB (see src/db/client.ts).
 */
export function openMemDb(projectTag: string, storagePath: string): Database {
  const path = join(expandHome(storagePath), "projects", `${projectTag}.db`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  ensureMemSchema(db);
  return db;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function rowToMemory(row: MemoryRow, tags: string[]): MemRecord {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    tags,
    projectTag: row.project_tag,
    projectPath: row.project_path,
    projectName: row.project_name,
    gitRepoUrl: row.git_repo_url,
    userName: row.user_name,
    userEmail: row.user_email,
    contentHash: row.content_hash,
    isPinned: row.is_pinned !== 0,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseMetadata(row.metadata),
  };
}

function getTagsForMemory(db: Database, memoryId: string): string[] {
  const rows = db
    .query("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY rowid")
    .all(memoryId) as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

/** Normalize a tag list: trim, drop empties, dedup preserving first-seen order. */
function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function loadMemory(db: Database, id: string): MemRecord | null {
  const row = db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | null;
  if (!row) return null;
  return rowToMemory(row, getTagsForMemory(db, id));
}

/**
 * Insert a memory, or return the existing row when its trimmed content hashes
 * to an already-stored `content_hash` (exact dedup).
 */
export function addMemory(
  db: Database,
  input: AddMemoryInput,
): { memory: MemRecord; deduplicated: boolean } {
  const contentHash = sha256(input.content.trim());
  const existing = db
    .query("SELECT * FROM memories WHERE content_hash = ?")
    .get(contentHash) as MemoryRow | null;
  if (existing) {
    return {
      memory: rowToMemory(existing, getTagsForMemory(db, existing.id)),
      deduplicated: true,
    };
  }

  const id = randomUUID();
  const now = Date.now();
  const type = input.type ?? "note";
  const source = input.source ?? "manual";
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  const identity = input.identity;
  const tags = dedupeTags(input.tags ?? []);

  const txn = db.transaction(() => {
    db.query(
      `INSERT INTO memories (
        id, content, type, project_tag, project_path, project_name, git_repo_url,
        user_name, user_email, content_hash, is_pinned, source, created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.content,
      type,
      identity.projectTag,
      identity.projectPath ?? null,
      identity.projectName ?? null,
      identity.gitRepoUrl ?? null,
      identity.userName ?? null,
      identity.userEmail ?? null,
      contentHash,
      input.pinned ? 1 : 0,
      source,
      now,
      now,
      metadata,
    );
    for (const tag of tags) {
      db.query("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)").run(id, tag);
    }
  });
  txn();

  const created = loadMemory(db, id);
  if (!created) {
    throw new Error(`ndomo: memory not found after insert: ${id}`);
  }
  return { memory: created, deduplicated: false };
}

export function getMemory(db: Database, id: string): MemRecord | null {
  return loadMemory(db, id);
}

export function listMemories(
  db: Database,
  opts: ListMemoriesOptions = {},
): { memories: MemRecord[]; total: number } {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  let join = "";

  if (opts.tag !== undefined) {
    join = " JOIN memory_tags mt ON mt.memory_id = m.id";
    where.push("mt.tag = ?");
    params.push(opts.tag);
  }
  if (opts.type !== undefined) {
    where.push("m.type = ?");
    params.push(opts.type);
  }
  if (opts.pinned !== undefined) {
    where.push("m.is_pinned = ?");
    params.push(opts.pinned ? 1 : 0);
  }

  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const countRow = db
    .query(`SELECT COUNT(*) AS total FROM memories m${join}${whereSql}`)
    .get(...params) as { total: number };

  const rows = db
    .query(
      `SELECT m.* FROM memories m${join}${whereSql} ORDER BY m.is_pinned DESC, m.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as MemoryRow[];

  const memories = rows.map((row) => rowToMemory(row, getTagsForMemory(db, row.id)));
  return { memories, total: countRow.total };
}

/**
 * Patch a memory. When `content` changes, `content_hash` is recomputed; if the
 * new hash collides with a different row, throws (the UNIQUE constraint would
 * otherwise surface an opaque SQLite error).
 */
export function updateMemory(
  db: Database,
  id: string,
  patch: { content?: string; type?: string; tags?: string[]; pinned?: boolean },
): MemRecord | null {
  const existing = db.query("SELECT id FROM memories WHERE id = ?").get(id) as {
    id: string;
  } | null;
  if (!existing) return null;

  const fields: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (patch.content !== undefined) {
    const contentHash = sha256(patch.content.trim());
    const collision = db
      .query("SELECT id FROM memories WHERE content_hash = ? AND id != ?")
      .get(contentHash, id) as { id: string } | null;
    if (collision) {
      throw new Error(
        `ndomo: content hash collision for memory ${id}: ${contentHash} already used by ${collision.id}`,
      );
    }
    fields.push("content = ?", "content_hash = ?");
    params.push(patch.content, contentHash);
  }
  if (patch.type !== undefined) {
    fields.push("type = ?");
    params.push(patch.type);
  }
  if (patch.pinned !== undefined) {
    fields.push("is_pinned = ?");
    params.push(patch.pinned ? 1 : 0);
  }
  fields.push("updated_at = ?");
  params.push(Date.now());

  const txn = db.transaction(() => {
    db.query(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...params, id);
    if (patch.tags !== undefined) {
      db.query("DELETE FROM memory_tags WHERE memory_id = ?").run(id);
      for (const tag of dedupeTags(patch.tags)) {
        db.query("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)").run(id, tag);
      }
    }
  });
  txn();

  return loadMemory(db, id);
}

export function deleteMemory(db: Database, id: string): boolean {
  const result = db.query("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}

export function statsMemories(db: Database): MemStats {
  const totalRow = db.query("SELECT COUNT(*) AS total FROM memories").get() as { total: number };
  const pinnedRow = db
    .query("SELECT COUNT(*) AS pinned FROM memories WHERE is_pinned = 1")
    .get() as { pinned: number };
  const typeRows = db
    .query("SELECT type, COUNT(*) AS count FROM memories GROUP BY type")
    .all() as Array<{ type: string; count: number }>;
  const tagRows = db
    .query("SELECT tag, COUNT(*) AS count FROM memory_tags GROUP BY tag")
    .all() as Array<{ tag: string; count: number }>;
  const rangeRow = db
    .query("SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memories")
    .get() as { oldest: number | null; newest: number | null };

  const byType: Record<string, number> = {};
  for (const row of typeRows) byType[row.type] = row.count;
  const byTag: Record<string, number> = {};
  for (const row of tagRows) byTag[row.tag] = row.count;

  return {
    total: totalRow.total,
    byType,
    byTag,
    pinned: pinnedRow.pinned,
    oldest: rangeRow.oldest,
    newest: rangeRow.newest,
  };
}

/**
 * List the per-project DB files under <storage>/projects. WAL sidecars
 * (`-wal` / `-shm`) are excluded; a missing directory yields [].
 */
export function listProjectDbs(storagePath: string): Array<{ tag: string; path: string }> {
  const dir = join(expandHome(storagePath), "projects");
  if (!existsSync(dir)) return [];
  const out: Array<{ tag: string; path: string }> = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".db")) continue;
    out.push({ tag: basename(entry, ".db"), path: join(dir, entry) });
  }
  return out;
}
