/**
 * ndomo memory — FlexSearch ranking layer.
 *
 * Split of responsibilities (design doc: memory-embedded-db-replacement):
 *   - SQLite (src/mem/store.ts) is the source of truth: it persists, filters
 *     (type / tag / pinned) and hydrates full records.
 *   - FlexSearch ranks a project's memories in-process and returns ordered ids.
 *
 * One Document index per project, built lazily on first search from the SQLite
 * DB and cached for the process lifetime. Writes are kept coherent through the
 * incremental helpers (indexMemory / removeFromIndex) used by the plugin tools.
 *
 * The index is deliberately NOT persisted: ~400 docs rebuild in the low ms and
 * a stale on-disk index would be a second source of truth to invalidate.
 */

import { Document } from "flexsearch";
import type { ListMemoriesOptions, MemRecord } from "./store.ts";
import { listMemories, listProjectDbs, openMemDb } from "./store.ts";

export type MemSearchResult = {
  id: string;
  content: string;
  type: string;
  tags: string[];
  projectTag: string;
  createdAt: number;
  score: number;
  excerpt: string;
};

export type MemSearchOptions = {
  scope?: "project" | "all-projects";
  type?: string;
  tag?: string;
  limit?: number;
};

/** How many ranked ids we ask FlexSearch for per query (pre-filter ceiling). */
const RANK_LIMIT = 1000;

/** Hard ceiling for a single project's hydration pass. */
const PROJECT_FETCH_LIMIT = 1000;

/**
 * In-process index cache, keyed by `<storagePath>::<projectTag>`. The storage
 * path is part of the key so two different storage roots (e.g. tmp dirs in
 * tests) never share an index.
 */
const indexCache = new Map<string, Document>();

function cacheKey(storagePath: string, projectTag: string): string {
  return `${storagePath}::${projectTag}`;
}

/** A FlexSearch Document hit bucket: ids ranked within one indexed field. */
type FlexFieldHits = { result: Array<string | number> };

function buildIndex(storagePath: string, projectTag: string): Document {
  const index = new Document({
    index: [{ field: "content", tokenize: "forward" }, { field: "tags" }, { field: "type" }],
    id: "id",
  });

  const db = openMemDb(projectTag, storagePath);
  try {
    const { memories } = listMemories(db, { limit: 100000 });
    for (const memory of memories) {
      index.add({
        id: memory.id,
        content: memory.content,
        tags: memory.tags.join(" "),
        type: memory.type,
      });
    }
  } finally {
    db.close();
  }
  return index;
}

/** Get the cached index for a project, building it on first use. */
function getIndex(storagePath: string, projectTag: string): Document {
  const key = cacheKey(storagePath, projectTag);
  const cached = indexCache.get(key);
  if (cached) return cached;
  const built = buildIndex(storagePath, projectTag);
  indexCache.set(key, built);
  return built;
}

/**
 * Flatten FlexSearch field buckets into a single ranked id list.
 *
 * FlexSearch returns one bucket per indexed field in configured order
 * (content, tags, type). Flattening in that order makes content matches outrank
 * tag-only matches; dedup by first appearance keeps the best rank for an id
 * that matched in several fields.
 */
function rankIds(index: Document, query: string): string[] {
  const hits = index.search(query, { limit: RANK_LIMIT }) as FlexFieldHits[];
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const bucket of hits) {
    for (const raw of bucket.result) {
      const id = String(raw);
      if (seen.has(id)) continue;
      seen.add(id);
      ranked.push(id);
    }
  }
  return ranked;
}

/**
 * Excerpt around the first query term (case-insensitive). Falls back to a
 * truncated prefix when the term only matched a non-content field (tags/type).
 * Output length stays bounded (<= ~250 chars).
 */
function buildExcerpt(content: string, query: string): string {
  const firstTerm = query.trim().split(/\s+/).filter(Boolean)[0];
  if (firstTerm) {
    const idx = content.toLowerCase().indexOf(firstTerm.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(content.length, idx + firstTerm.length + 80);
      let excerpt = content.slice(start, end);
      if (start > 0) excerpt = `…${excerpt}`;
      if (end < content.length) excerpt = `${excerpt}…`;
      return excerpt;
    }
  }
  return content.length > 160 ? `${content.slice(0, 160)}…` : content;
}

function toResult(record: MemRecord, score: number, query: string): MemSearchResult {
  return {
    id: record.id,
    content: record.content,
    type: record.type,
    tags: record.tags,
    projectTag: record.projectTag,
    createdAt: record.createdAt,
    score,
    excerpt: buildExcerpt(record.content, query),
  };
}

/**
 * Rank + hydrate a single project. SQL applies the type/tag filters, the
 * FlexSearch rank order is preserved, and the result is cut to `hardLimit`.
 *
 * score = 1 / (rank + 1) where `rank` is the id's position in the flattened,
 * deduped ranked list *before* SQL filtering — a deterministic, dependency-free
 * relevance proxy (1.0 for the top hit, 0.5 for the second, …).
 */
function searchProject(
  storagePath: string,
  projectTag: string,
  query: string,
  opts: MemSearchOptions,
  hardLimit: number,
): MemSearchResult[] {
  const index = getIndex(storagePath, projectTag);
  const ranked = rankIds(index, query);
  if (ranked.length === 0) return [];

  const db = openMemDb(projectTag, storagePath);
  try {
    const filters: ListMemoriesOptions = {
      limit: 100000,
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
    };
    const { memories } = listMemories(db, filters);
    const byId = new Map(memories.map((memory) => [memory.id, memory]));

    const results: MemSearchResult[] = [];
    for (let rank = 0; rank < ranked.length; rank++) {
      const id = ranked[rank];
      if (id === undefined) continue;
      const record = byId.get(id);
      if (!record) continue;
      results.push(toResult(record, 1 / (rank + 1), query));
      if (results.length >= hardLimit) break;
    }
    return results;
  } finally {
    db.close();
  }
}

/**
 * Search memories in a project (or across every project DB under storagePath).
 * Returns [] for an empty/blank query or when nothing matches.
 */
export function searchMemories(
  storagePath: string,
  projectTag: string,
  query: string,
  opts: MemSearchOptions = {},
): MemSearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const scope = opts.scope ?? "project";
  const limit = opts.limit ?? 10;
  if (limit <= 0) return [];

  if (scope === "all-projects") {
    const merged: MemSearchResult[] = [];
    for (const { tag } of listProjectDbs(storagePath)) {
      merged.push(...searchProject(storagePath, tag, trimmed, opts, PROJECT_FETCH_LIMIT));
    }
    // Cross-project merge: relevance first, then most recent as tie-break.
    merged.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    return merged.slice(0, limit);
  }

  return searchProject(storagePath, projectTag, trimmed, opts, limit);
}

/** Incrementally index a memory (call after addMemory) so it is searchable. */
export function indexMemory(storagePath: string, projectTag: string, memory: MemRecord): void {
  const index = getIndex(storagePath, projectTag);
  index.add({
    id: memory.id,
    content: memory.content,
    tags: memory.tags.join(" "),
    type: memory.type,
  });
}

/**
 * Drop a memory from the cached index (call after deleteMemory). A no-op when
 * the index was never built — never forces a build just to remove one id.
 */
export function removeFromIndex(storagePath: string, projectTag: string, id: string): void {
  const index = indexCache.get(cacheKey(storagePath, projectTag));
  if (!index) return;
  index.remove(id);
}

/** Clear every cached index. Used for isolation in tests and on storage reset. */
export function clearSearchCache(): void {
  indexCache.clear();
}
