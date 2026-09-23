/**
 * ndomo memory — one-shot migration from opencode-mem shards.
 *
 * Reads opencode-mem project shards (`~/.opencode-mem/data/projects/*.db`) in
 * readonly mode and copies every row into the ndomo embedded store
 * (`<target>/projects/<ndomo_project_tag>.db`), swapping the container-tag
 * prefix (`opencode_` → `ndomo_`) and preserving the original hash identity.
 *
 * The migration is idempotent: rows are deduplicated by the exact
 * `content_hash` (sha256 of trimmed content), the same key `store.ts` uses.
 * `dryRun` counts what would happen without opening a writable target.
 */

import type { Database } from "bun:sqlite";
import { Database as SqliteDatabase } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { expandHome, openMemDb } from "./store.ts";

export type MigrateShardReport = {
  shard: string;
  containerTag: string;
  projectTag: string;
  migrated: number;
  skipped: number;
  errors: string[];
};

export type MigrationReport = {
  source: string;
  target: string;
  dryRun: boolean;
  projects: MigrateShardReport[];
  migrated: number;
  skipped: number;
  errors: string[];
};

type ShardRow = {
  id: string;
  content: string;
  type: string | null;
  tags: string | null;
  container_tag: string;
  created_at: number | null;
  updated_at: number | null;
  is_pinned: number | null;
  metadata: string | null;
  user_name: string | null;
  user_email: string | null;
  project_path: string | null;
  project_name: string | null;
  git_repo_url: string | null;
};

/** Full 64-char sha256 hex digest — mirrors store.ts (exact dedup key). */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Swap the container-tag prefix. `opencode_project_X` → `ndomo_project_X`,
 * `opencode_user_X` → `ndomo_user_X`; any other tag is returned untouched.
 */
export function mapContainerTag(tag: string): string {
  if (tag.startsWith("opencode_")) {
    return `ndomo_${tag.slice("opencode_".length)}`;
  }
  return tag;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Parse an opencode-mem `tags` column. Values are either a plain CSV
 * (`"a,b,c"`) or a JSON array string (`'["a","b"]'`); both are normalized to a
 * trimmed, deduplicated list. A malformed JSON array falls back to CSV split.
 */
export function parseTagsCsv(raw: string | null): string[] {
  if (raw === null) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return dedupe(parsed.filter((value): value is string => typeof value === "string"));
      }
    } catch {
      // fall through to CSV split
    }
  }
  return dedupe(trimmed.split(","));
}

/** Merge the original metadata object with the `migratedFrom` provenance block. */
function mergeMetadata(
  raw: string | null,
  migratedFrom: { container_tag: string; shard: string },
): string {
  let base: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // malformed metadata is dropped; provenance is still recorded
    }
  }
  return JSON.stringify({ ...base, migratedFrom });
}

/** Resolve (and cache) the target handle for a project tag. */
function resolveTargetDb(
  projectTag: string,
  targetRoot: string,
  dryRun: boolean,
  writeCache: Map<string, Database>,
  readonlyCache: Map<string, Database | null>,
): Database | null {
  if (!dryRun) {
    const cached = writeCache.get(projectTag);
    if (cached) return cached;
    const db = openMemDb(projectTag, targetRoot);
    writeCache.set(projectTag, db);
    return db;
  }
  if (readonlyCache.has(projectTag)) return readonlyCache.get(projectTag) ?? null;
  const path = join(expandHome(targetRoot), "projects", `${projectTag}.db`);
  if (!existsSync(path)) {
    readonlyCache.set(projectTag, null);
    return null;
  }
  const db = new SqliteDatabase(path, { readonly: true });
  readonlyCache.set(projectTag, db);
  return db;
}

function listShards(sourceDir: string): string[] {
  if (!existsSync(sourceDir)) return [];
  return readdirSync(sourceDir)
    .filter((entry) => entry.endsWith(".db") && !entry.endsWith("-wal") && !entry.endsWith("-shm"))
    .map((entry) => join(sourceDir, entry))
    .sort();
}

const SELECT_ROWS = `
  SELECT id, content, type, tags, container_tag, created_at, updated_at, is_pinned,
         metadata, user_name, user_email, project_path, project_name, git_repo_url
  FROM memories
`;

/**
 * Migrate every opencode-mem shard under `source` into the ndomo store at
 * `target`. Never throws for a missing source: it returns a report whose
 * `errors` describes the problem. Row-level failures are collected per shard
 * and do not abort the run.
 */
export function migrateMemories(opts: {
  source: string;
  target: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}): MigrationReport {
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? (() => {});
  const sourceDir = expandHome(opts.source);
  const report: MigrationReport = {
    source: opts.source,
    target: opts.target,
    dryRun,
    projects: [],
    migrated: 0,
    skipped: 0,
    errors: [],
  };

  if (!existsSync(sourceDir)) {
    report.errors.push(`source not found: ${sourceDir}`);
    return report;
  }

  const shards = listShards(sourceDir);
  const writeCache = new Map<string, Database>();
  const readonlyCache = new Map<string, Database | null>();

  try {
    for (const shardPath of shards) {
      const shard = basename(shardPath);
      const shardReport: MigrateShardReport = {
        shard,
        containerTag: "",
        projectTag: "",
        migrated: 0,
        skipped: 0,
        errors: [],
      };
      report.projects.push(shardReport);

      let sourceDb: Database | null = null;
      try {
        sourceDb = new SqliteDatabase(shardPath, { readonly: true });
        const rows = sourceDb.query(SELECT_ROWS).all() as ShardRow[];

        if (rows.length > 0) {
          const firstTag = String(rows[0]?.container_tag ?? "");
          shardReport.containerTag = firstTag;
          shardReport.projectTag = mapContainerTag(firstTag);
        }

        log(`migrate: ${shard} → ${shardReport.projectTag || "(unknown)"} (${rows.length} rows)`);

        for (const row of rows) {
          try {
            const containerTag = String(row.container_tag ?? "");
            const projectTag = mapContainerTag(containerTag);
            const content = String(row.content ?? "");
            const contentHash = sha256(content.trim());
            const targetDb = resolveTargetDb(
              projectTag,
              opts.target,
              dryRun,
              writeCache,
              readonlyCache,
            );

            const existing = targetDb
              ? (targetDb
                  .query("SELECT id FROM memories WHERE content_hash = ?")
                  .get(contentHash) as { id: string } | null)
              : null;
            if (existing) {
              shardReport.skipped += 1;
              continue;
            }

            shardReport.migrated += 1;
            if (dryRun || !targetDb) continue;

            const createdAt = row.created_at ?? Date.now();
            const updatedAt = row.updated_at ?? createdAt;
            const type = row.type ?? "note";
            const metadata = mergeMetadata(row.metadata, {
              container_tag: containerTag,
              shard,
            });
            const tags = parseTagsCsv(row.tags);

            const txn = targetDb.transaction(() => {
              targetDb
                .query(
                  `INSERT INTO memories (
                    id, content, type, project_tag, project_path, project_name, git_repo_url,
                    user_name, user_email, content_hash, is_pinned, source, created_at, updated_at, metadata
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  String(row.id),
                  content,
                  type,
                  projectTag,
                  row.project_path ?? null,
                  row.project_name ?? null,
                  row.git_repo_url ?? null,
                  row.user_name ?? null,
                  row.user_email ?? null,
                  contentHash,
                  row.is_pinned ? 1 : 0,
                  "migration",
                  createdAt,
                  updatedAt,
                  metadata,
                );
              for (const tag of tags) {
                targetDb
                  .query("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)")
                  .run(String(row.id), tag);
              }
            });
            txn();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            shardReport.errors.push(`${shard}: row ${String(row.id)}: ${message}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        shardReport.errors.push(`${shard}: ${message}`);
      } finally {
        sourceDb?.close();
      }

      report.migrated += shardReport.migrated;
      report.skipped += shardReport.skipped;
      report.errors.push(...shardReport.errors);
    }
  } finally {
    for (const db of writeCache.values()) db.close();
    for (const db of readonlyCache.values()) db?.close();
  }

  return report;
}
