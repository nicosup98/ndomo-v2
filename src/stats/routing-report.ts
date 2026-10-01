/**
 * Routing report — aggregate distributions over `routing_events` (v18,
 * harness-intelligence fase 2).
 *
 * Shared core behind `ndomo stats --routing` (`src/cli/stats.ts`) and the MCP
 * `stats` tool with `query: "routing"` (`src/plugin.ts`): callers own the
 * `bun:sqlite` handle, so the aggregation stays synchronous, pure and
 * unit-testable against a temp DB — same contract as agent-scorecard.ts.
 *
 * Windows reuse the scorecard vocabulary (`7d` | `30d` | `all`, default
 * `all`) over `routing_events.created_at`, which is NOT NULL — no COALESCE
 * needed (unlike the task-side scorecard).
 *
 * Coverage answers "did this route decision produce a task?":
 *  - `linked`   — the event carries `task_id` (explicit write-time link via
 *                 `linkRoutingEvent` on a terminal transition).
 *  - `inferred` — no link, but a terminal task of the SAME agent completed
 *                 inside [event.created_at, +24h] (read-time inference from
 *                 the design doc; LIMIT 1 short-circuits on first hit).
 *  - `orphan`   — neither (route fired but no attributable task).
 *
 * The table is already capped at ROUTING_EVENTS_MAX (5000) by app-layer
 * prune, so a full scan is bounded and cheap.
 */

import type { Database } from "bun:sqlite";
import { bucketForTask, type HistoryIntent } from "../orchestrator/agent-history.ts";
import type { ScorecardSince } from "./agent-scorecard.ts";

/** Milliseconds in a day (mirrors agent-scorecard.ts, which keeps its own private). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Days behind each non-`all` window (mirrors agent-scorecard.ts). */
const SINCE_DAYS: Record<Exclude<ScorecardSince, "all">, number> = { "7d": 7, "30d": 30 };

/** Inference window: task completion within 24h after the route decision. */
const INFER_WINDOW_MS = DAY_MS;

/** Top-N slices for the agent/bucket distributions (sources stay complete). */
const TOP_N = 10;

/** One counted group (`bySource` / `byAgent` / `byBucket` rows). */
export interface RoutingCount {
  key: string;
  count: number;
}

/** Full routing report (the JSON payload of CLI `--routing --json` / the tool). */
export interface RoutingReport {
  since: ScorecardSince;
  /** Epoch-ms lower bound of the window, or null for `since: "all"`. */
  windowStart: number | null;
  generatedAt: number;
  total: number;
  /** Every source, count desc → source asc (complete list, no slicing). */
  bySource: Array<{ source: string; count: number }>;
  /** 0–100 rounded to one decimal; null when `total === 0`. */
  fallbackPct: number | null;
  /** 0–100 rounded to one decimal; null when `total === 0`. */
  explorePct: number | null;
  /** Top 10 agents, count desc → agent asc. */
  byAgent: Array<{ agent: string; count: number }>;
  /** Top 10 `intent:stack` buckets, count desc → bucket asc. */
  byBucket: Array<{ bucket: string; count: number }>;
  coverage: { linked: number; inferred: number; orphan: number };
}

/** Options accepted by {@link computeRoutingReport}. */
export interface RoutingReportOptions {
  since?: ScorecardSince;
  /** Injectable clock for deterministic window tests. */
  now?: number;
}

/** Raw columns needed for the report (subset of SCHEMA_V18_SQL). */
interface RoutingEventRow {
  id: string;
  created_at: number;
  agent: string;
  source: string;
  intent: string | null;
  stack: string | null;
  fallback: number;
  explore: number;
  task_id: string | null;
}

/** Round to one decimal place (percentages) — same rule as agent-scorecard. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Deterministic ordering for every distribution: count desc, then key asc
 * via localeCompare (stable across runs on the same machine).
 */
function sortedCounts(counts: Map<string, number>): RoutingCount[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Bucket key for a stored event: `intent:stack` through the scheduler's own
 * `bucketForTask`, so CLI/tool and `agent-history` agree on bucket naming.
 *
 * `files` is unknown for a routing event (the row is slim), so the bucket
 * falls back to the stored `stack` — and to `generic` when the stack is not
 * one of TASK_STACKS (js|vue|go|python|zig).
 *
 * `intent` is nullable in the schema (raw-SQL inserts can omit it); such rows
 * land in an `unknown:<stack>` bucket instead of being dropped. The `route`
 * tool always writes a valid intent, so this only fires on manual rows.
 */
function bucketOf(intent: string | null, stack: string | null): string {
  return bucketForTask((intent ?? "unknown") as HistoryIntent, undefined, stack ?? undefined);
}

/** True when a terminal task of `agent` completed within [from, from+24h]. */
function hasInferredTask(db: Database, agent: string, createdAt: number): boolean {
  const hit = db
    .query(
      `SELECT 1 FROM plan_tasks
        WHERE agent = ?
          AND status IN ('done', 'failed')
          AND completed_at IS NOT NULL
          AND completed_at >= ?
          AND completed_at <= ?
        LIMIT 1`,
    )
    .get(agent, createdAt, createdAt + INFER_WINDOW_MS);
  return hit !== null;
}

/**
 * Compute the routing report for a state DB.
 *
 * Deterministic: agent/bucket ordering is count desc → key asc, sources are
 * complete, and `now` is injectable so window tests never depend on wall time.
 * Empty DB → total 0, null percentages, empty arrays, zeroed coverage.
 */
export function computeRoutingReport(
  db: Database,
  options: RoutingReportOptions = {},
): RoutingReport {
  const now = options.now ?? Date.now();
  const since: ScorecardSince = options.since ?? "all";
  const windowStart = since === "all" ? null : now - SINCE_DAYS[since] * DAY_MS;

  const rows =
    windowStart === null
      ? (db
          .query(
            `SELECT id, created_at, agent, source, intent, stack, fallback, explore, task_id
               FROM routing_events
              ORDER BY created_at ASC, rowid ASC`,
          )
          .all() as RoutingEventRow[])
      : (db
          .query(
            `SELECT id, created_at, agent, source, intent, stack, fallback, explore, task_id
               FROM routing_events
              WHERE created_at >= ?
              ORDER BY created_at ASC, rowid ASC`,
          )
          .all(windowStart) as RoutingEventRow[]);

  const total = rows.length;
  const coverage = { linked: 0, inferred: 0, orphan: 0 };
  let fallbackCount = 0;
  let exploreCount = 0;

  const sourceCounts = new Map<string, number>();
  const agentCounts = new Map<string, number>();
  const bucketCounts = new Map<string, number>();

  for (const row of rows) {
    sourceCounts.set(row.source, (sourceCounts.get(row.source) ?? 0) + 1);
    agentCounts.set(row.agent, (agentCounts.get(row.agent) ?? 0) + 1);
    const bucket = bucketOf(row.intent, row.stack);
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    if (row.fallback === 1) fallbackCount += 1;
    if (row.explore === 1) exploreCount += 1;

    if (row.task_id !== null) {
      coverage.linked += 1;
    } else if (hasInferredTask(db, row.agent, row.created_at)) {
      coverage.inferred += 1;
    } else {
      coverage.orphan += 1;
    }
  }

  const bySource = sortedCounts(sourceCounts).map(({ key, count }) => ({
    source: key,
    count,
  }));
  const byAgent = sortedCounts(agentCounts)
    .slice(0, TOP_N)
    .map(({ key, count }) => ({ agent: key, count }));
  const byBucket = sortedCounts(bucketCounts)
    .slice(0, TOP_N)
    .map(({ key, count }) => ({ bucket: key, count }));

  return {
    since,
    windowStart,
    generatedAt: now,
    total,
    bySource,
    fallbackPct: total === 0 ? null : round1((fallbackCount / total) * 100),
    explorePct: total === 0 ? null : round1((exploreCount / total) * 100),
    byAgent,
    byBucket,
    coverage,
  };
}
