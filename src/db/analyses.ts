/**
 * ndomo DB — Analysis CRUD with FTS5 search.
 *
 * All functions take a Database instance and return camelCase TS types.
 * Uses TEXT timestamps (ISO datetime) unlike INTEGER epoch in other tables.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { escapeFtsQuery } from "./fts-escape.ts";
import type { Analysis, InsertAnalysis } from "./types.ts";
import { analysisFromRow } from "./types.ts";

// ─── Validation helpers ─────────────────────────────────────────────────────

function validateSlug(slug: string): void {
  if (!slug || slug.trim().length === 0) {
    throw new Error("ndomo: analysis slug cannot be empty");
  }
}

function validateProjectPath(projectPath: string): void {
  if (!projectPath || projectPath.trim().length === 0) {
    throw new Error("ndomo: analysis projectPath cannot be empty");
  }
}

/**
 * Agent-aware validation of analysis findings JSON.
 *
 * Boundary policy (ndomo agent contract):
 *  - `ranger` emits observation-only findings (factual, descriptive).
 *    Rangers MUST NOT include `proposedAction` because they lack decision authority.
 *  - `foreman` and other decision-capable agents MAY include `proposedAction`.
 *
 * Behavior:
 *  - If findingsJson is undefined → no-op (field not being set).
 *  - If findingsJson is not valid JSON → no-op (let the existing JSON.parse
 *    in the tool layer surface the parse error). This helper focuses on the
 *    semantic boundary check, not syntax.
 *  - If findingsJson parses to a non-array (or empty array) → no-op.
 *  - If agent === 'ranger' AND any parsed finding has a `proposedAction` key
 *    → throw a clear validation error.
 *
 * Pure: no DB access. Safe to call from plugin.ts tool handlers before write.
 */
export function validateAnalysisFindings(
  findingsJson: string | undefined,
  agent: string | undefined,
): void {
  if (findingsJson === undefined) return;
  if (agent !== "ranger") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(findingsJson);
  } catch {
    // Defer parse errors to the JSON.parse call in the tool handler.
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return;

  for (const item of parsed) {
    if (item !== null && typeof item === "object" && "proposedAction" in item) {
      throw new Error(
        "ndomo: ranger cannot emit proposedAction on analysis findings (observation-only contract); foreman/decision-capable agents only",
      );
    }
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Create a new analysis. Validates slug uniqueness per project_path.
 * Throws if slug already exists for the same project_path.
 */
export function createAnalysis(db: Database, input: InsertAnalysis): Analysis {
  validateSlug(input.slug);
  validateProjectPath(input.projectPath);

  const id = randomUUID();
  const slug = input.slug.trim();
  const title = input.title.trim();
  const projectPath = input.projectPath.trim();
  const summary = input.summary?.trim() ?? "";
  const findingsJson = input.findingsJson ?? "[]";
  const agent = input.agent ?? "ranger";

  // Check uniqueness (slug, project_path)
  const existing = db
    .query("SELECT id FROM analyses WHERE slug = ? AND project_path = ?")
    .get(slug, projectPath) as { id: string } | null;
  if (existing) {
    throw new Error(
      `ndomo: analysis with slug '${slug}' already exists for project '${projectPath}'`,
    );
  }

  db.query(
    `INSERT INTO analyses (id, slug, title, project_path, summary, findings_json, source_plan_id, agent, session_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    title,
    projectPath,
    summary,
    findingsJson,
    input.sourcePlanId ?? null,
    agent,
    input.sessionId ?? null,
    input.createdBy ?? null,
  );

  return getAnalysis(db, id)!;
}

/**
 * Get analysis by id. Returns null if not found or archived.
 * Set includeArchived=true to include soft-deleted.
 */
export function getAnalysis(
  db: Database,
  id: string,
  opts?: { includeArchived?: boolean },
): Analysis | null {
  const includeArchived = opts?.includeArchived ?? false;
  const sql = includeArchived
    ? "SELECT * FROM analyses WHERE id = ?"
    : "SELECT * FROM analyses WHERE id = ? AND archived_at IS NULL";
  const row = db.query(sql).get(id);
  return row ? analysisFromRow(row) : null;
}

/**
 * Get analysis by slug + project_path. Returns null if not found.
 */
export function getAnalysisBySlug(
  db: Database,
  slug: string,
  projectPath: string,
  opts?: { includeArchived?: boolean },
): Analysis | null {
  const includeArchived = opts?.includeArchived ?? false;
  const sql = includeArchived
    ? "SELECT * FROM analyses WHERE slug = ? AND project_path = ?"
    : "SELECT * FROM analyses WHERE slug = ? AND project_path = ? AND archived_at IS NULL";
  const row = db.query(sql).get(slug, projectPath);
  return row ? analysisFromRow(row) : null;
}

/**
 * List analyses with optional filters.
 */
export function listAnalyses(
  db: Database,
  filters?: {
    sourcePlanId?: string;
    agent?: string;
    archived?: boolean;
    projectPath?: string;
    limit?: number;
  },
): Analysis[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.sourcePlanId) {
    clauses.push("source_plan_id = ?");
    params.push(filters.sourcePlanId);
  }
  if (filters?.agent) {
    clauses.push("agent = ?");
    params.push(filters.agent);
  }
  if (filters?.projectPath) {
    clauses.push("project_path = ?");
    params.push(filters.projectPath);
  }
  if (!filters?.archived) {
    clauses.push("archived_at IS NULL");
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filters?.limit ?? 50;
  params.push(limit);

  const rows = db
    .query(`SELECT * FROM analyses ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params);
  return (rows as unknown[]).map(analysisFromRow);
}

/**
 * FTS5 search over title+summary+findings_json.
 * Uses escapeFtsQuery to safely wrap query terms.
 */
export function searchAnalyses(
  db: Database,
  query: string,
  filters?: {
    sourcePlanId?: string;
    agent?: string;
    archived?: boolean;
    limit?: number;
  },
): Analysis[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.sourcePlanId) {
    clauses.push("a.source_plan_id = ?");
    params.push(filters.sourcePlanId);
  }
  if (filters?.agent) {
    clauses.push("a.agent = ?");
    params.push(filters.agent);
  }
  if (!filters?.archived) {
    clauses.push("a.archived_at IS NULL");
  }

  const extraWhere = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
  const limit = filters?.limit ?? 20;
  params.push(limit);

  const rows = db
    .query(
      `SELECT a.* FROM analyses a
       JOIN analyses_fts fts ON a.rowid = fts.rowid
       WHERE analyses_fts MATCH ?
       ${extraWhere}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escapeFtsQuery(query), ...params);
  return (rows as unknown[]).map(analysisFromRow);
}

/**
 * Update analysis fields. Returns updated analysis.
 * Automatically bumps updated_at. Throws if analysis not found.
 */
export function updateAnalysis(
  db: Database,
  id: string,
  updates: Partial<InsertAnalysis>,
): Analysis {
  const existing = getAnalysis(db, id);
  if (!existing) {
    throw new Error(`ndomo: analysis '${id}' not found`);
  }

  const setClauses: string[] = [];
  const params: (string | null)[] = [];

  if (updates.slug !== undefined) {
    validateSlug(updates.slug);
    setClauses.push("slug = ?");
    params.push(updates.slug.trim());
  }
  if (updates.title !== undefined) {
    setClauses.push("title = ?");
    params.push(updates.title.trim());
  }
  if (updates.projectPath !== undefined) {
    validateProjectPath(updates.projectPath);
    setClauses.push("project_path = ?");
    params.push(updates.projectPath.trim());
  }
  if (updates.summary !== undefined) {
    setClauses.push("summary = ?");
    params.push(updates.summary);
  }
  if (updates.findingsJson !== undefined) {
    setClauses.push("findings_json = ?");
    params.push(updates.findingsJson);
  }
  if (updates.sourcePlanId !== undefined) {
    setClauses.push("source_plan_id = ?");
    params.push(updates.sourcePlanId ?? null);
  }
  if (updates.agent !== undefined) {
    setClauses.push("agent = ?");
    params.push(updates.agent);
  }
  if (updates.sessionId !== undefined) {
    setClauses.push("session_id = ?");
    params.push(updates.sessionId ?? null);
  }
  if (updates.createdBy !== undefined) {
    setClauses.push("created_by = ?");
    params.push(updates.createdBy ?? null);
  }

  if (setClauses.length === 0) return existing; // no-op

  // Always bump updated_at
  setClauses.push("updated_at = datetime('now')");
  params.push(id);

  db.query(
    `UPDATE analyses SET ${setClauses.join(", ")} WHERE id = ?`,
  ).run(...params);

  return getAnalysis(db, id)!;
}

/**
 * Soft-delete: set archived_at to current timestamp.
 */
export function archiveAnalysis(db: Database, id: string): Analysis {
  const existing = getAnalysis(db, id, { includeArchived: true });
  if (!existing) {
    throw new Error(`ndomo: analysis '${id}' not found`);
  }
  // Idempotent: if already archived, just return
  if (existing.archivedAt) return existing;

  db.query(
    "UPDATE analyses SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(id);

  return getAnalysis(db, id, { includeArchived: true })!;
}

/**
 * Link analysis to a plan (set source_plan_id).
 * Use when analysis is created standalone and later linked to a plan.
 */
export function linkAnalysisToPlan(
  db: Database,
  id: string,
  planId: string,
): Analysis {
  const existing = getAnalysis(db, id);
  if (!existing) {
    throw new Error(`ndomo: analysis '${id}' not found`);
  }

  // FK enforces plan existence, but validate at app level for better error message
  const plan = db.query("SELECT id FROM plans WHERE id = ?").get(planId) as
    | { id: string }
    | null;
  if (!plan) {
    throw new Error(`ndomo: plan '${planId}' not found (FK violation)`);
  }

  db.query(
    "UPDATE analyses SET source_plan_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(planId, id);

  return getAnalysis(db, id)!;
}

/**
 * Unlink analysis from its source plan (set source_plan_id to NULL).
 * Idempotent: if already unlinked, just returns the analysis.
 */
export function unlinkAnalysisFromPlan(
  db: Database,
  id: string,
): Analysis {
  const existing = getAnalysis(db, id);
  if (!existing) {
    throw new Error(`ndomo: analysis '${id}' not found`);
  }

  db.query(
    "UPDATE analyses SET source_plan_id = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(id);

  return getAnalysis(db, id)!;
}
