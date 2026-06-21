#!/usr/bin/env bun
/**
 * ndomo status CLI — list plans grouped by status with task counts.
 *
 * Reads .ndomo/state.db from the project root (resolved same as client.ts).
 * Supports --json, --plans, --status <status> flags.
 *
 * Uses bun:sqlite (synchronous) — no async/await on DB ops.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";

/** Status display order — executing first, abandoned last. */
const STATUS_ORDER = [
  "executing",
  "approved",
  "draft",
  "completed",
  "failed",
  "abandoned",
] as const;

interface PlanRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  created_at: number;
  session_id: string | null;
}

interface TaskCountRow {
  plan_id: string;
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  blocked: number;
}

interface PlanStatus {
  id: string;
  slug: string;
  title: string;
  status: string;
  createdAt: number;
  sessionId: string | null;
  taskTotal: number;
  taskDone: number;
}

/**
 * Resolve DB path — same logic as src/db/client.ts.
 * Tries cwd first, then walks up to find .ndomo/state.db.
 */
function resolveDbPath(): string | null {
  // Try cwd
  const cwdPath = join(process.cwd(), NDOMO_DIR, DB_FILE);
  if (existsSync(cwdPath)) return cwdPath;

  // Try parent dirs (max 5 levels up)
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
    const candidate = join(dir, NDOMO_DIR, DB_FILE);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Human-readable age like "2h", "3d", "5m". */
function humanAge(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 0) return "now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

/** Short ID — first 8 chars. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Truncate string to maxLen with "..." suffix. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 3)}...`;
}

/**
 * Fetch all plans with task counts from DB.
 * Returns grouped output by status.
 */
function fetchPlans(dbPath: string, statusFilter?: string): Map<string, PlanStatus[]> {
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");

  try {
    // Fetch plans
    const planSql = statusFilter
      ? "SELECT id, slug, title, status, created_at, session_id FROM plans WHERE status = ? AND archived_at IS NULL ORDER BY created_at DESC"
      : "SELECT id, slug, title, status, created_at, session_id FROM plans WHERE archived_at IS NULL ORDER BY created_at DESC";
    const plans = statusFilter
      ? (db.query(planSql).all(statusFilter) as PlanRow[])
      : (db.query(planSql).all() as PlanRow[]);

    if (plans.length === 0) {
      db.close();
      return new Map();
    }

    // Fetch task counts for all plans in one query
    const planIds = plans.map((p) => p.id);
    const placeholders = planIds.map(() => "?").join(",");
    const taskCounts = db
      .query(
        `SELECT plan_id,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
        FROM plan_tasks
        WHERE plan_id IN (${placeholders}) AND archived_at IS NULL
        GROUP BY plan_id`,
      )
      .all(...planIds) as TaskCountRow[];

    const countMap = new Map<string, TaskCountRow>();
    for (const tc of taskCounts) {
      countMap.set(tc.plan_id, tc);
    }

    // Group by status
    const grouped = new Map<string, PlanStatus[]>();
    for (const p of plans) {
      const tc = countMap.get(p.id);
      const planStatus: PlanStatus = {
        id: p.id,
        slug: p.slug,
        title: p.title,
        status: p.status,
        createdAt: p.created_at,
        sessionId: p.session_id,
        taskTotal: tc?.total ?? 0,
        taskDone: tc?.done ?? 0,
      };
      const existing = grouped.get(p.status) ?? [];
      existing.push(planStatus);
      grouped.set(p.status, existing);
    }

    db.close();
    return grouped;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Print plans in caveman table format. */
function printTable(grouped: Map<string, PlanStatus[]>): void {
  let totalPlans = 0;
  for (const plans of grouped.values()) {
    totalPlans += plans.length;
  }

  if (totalPlans === 0) {
    console.log("no plans found");
    return;
  }

  for (const status of STATUS_ORDER) {
    const plans = grouped.get(status);
    if (!plans || plans.length === 0) continue;

    console.log(`\nPLANS — status: ${status} (${plans.length})`);
    console.log(
      `  ${"id".padEnd(10)}${"slug".padEnd(26)}${"title".padEnd(32)}${"age".padEnd(8)}${"session".padEnd(10)}tasks`,
    );

    for (const p of plans) {
      const id = shortId(p.id);
      const slug = truncate(p.slug, 24);
      const title = truncate(p.title, 30);
      const age = humanAge(p.createdAt);
      const session = p.sessionId ? shortId(p.sessionId) : "-";
      const tasks = p.taskTotal > 0 ? `${p.taskDone}/${p.taskTotal} done` : "no tasks";

      console.log(
        `  ${id.padEnd(10)}${slug.padEnd(26)}${title.padEnd(32)}${age.padEnd(8)}${session.padEnd(10)}${tasks}`,
      );
    }
  }
}

/** Print plans as JSON. */
function printJson(grouped: Map<string, PlanStatus[]>): void {
  const result: Record<string, PlanStatus[]> = {};
  for (const status of STATUS_ORDER) {
    const plans = grouped.get(status);
    if (plans && plans.length > 0) {
      result[status] = plans;
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

/** Parse CLI args and run. */
export function runStatus(args: string[]): void {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.error("error: .ndomo/state.db not found — run from project root or parent dir");
    process.exit(1);
  }

  let asJson = false;
  let showPlans = true; // default
  let statusFilter: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      asJson = true;
    } else if (arg === "--plans") {
      showPlans = true;
    } else if (arg === "--status" && i + 1 < args.length) {
      statusFilter = args[++i];
    }
  }

  if (showPlans) {
    const grouped = fetchPlans(dbPath, statusFilter);
    if (asJson) {
      printJson(grouped);
    } else {
      printTable(grouped);
    }
  }
}

// Direct execution
if (import.meta.main) {
  runStatus(process.argv.slice(2));
}
