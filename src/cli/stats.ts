#!/usr/bin/env bun
/**
 * ndomo stats CLI — per-agent scorecard (success rate, verify pass %,
 * duration percentiles, tokens, failure modes, escalations, bypasses) and
 * the routing-events report (`--routing`: sources, fallback/explore %, top
 * agents/buckets, task-link coverage).
 *
 * Reads .ndomo/state.db from the project root (resolved same as status.ts).
 * Supports --since 7d|30d|all (default all), --agent <name>, --routing and
 * --json. `--agent` applies to the scorecard only (ignored by --routing).
 *
 * Aggregation lives in src/stats/agent-scorecard.ts and
 * src/stats/routing-report.ts (both shared with the MCP `stats` tool); this
 * file only resolves the DB, renders and parses flags.
 *
 * Uses bun:sqlite (synchronous) — no async/await on DB ops.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  computeAgentScorecard,
  SCORECARD_SINCE_VALUES,
  type ScorecardReport,
  type ScorecardSince,
} from "../stats/agent-scorecard.ts";
import { computeRoutingReport, type RoutingReport } from "../stats/routing-report.ts";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";

/** Column widths for the table renderer (padEnd columns, status.ts style). */
const COL = {
  agent: 16,
  done: 6,
  failed: 7,
  blocked: 8,
  running: 8,
  pending: 8,
  success: 9,
  verify: 14,
  p50: 9,
  p95: 9,
  tokens: 11,
  esc: 5,
  byp: 5,
} as const;

/** Column widths for the `--routing` renderer. */
const RCOL = {
  source: 16,
  count: 8,
  pct: 8,
  agent: 16,
  bucket: 24,
} as const;

/**
 * Resolve DB path — same logic as src/cli/status.ts.
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

/** Narrow a raw flag value to a known window; null when invalid. */
function parseSince(raw: string): ScorecardSince | null {
  return SCORECARD_SINCE_VALUES.find((value) => value === raw) ?? null;
}

/** Truncate string to maxLen with "..." suffix (maxLen includes the suffix). */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 3)}...`;
}

/** Short id — first 8 chars. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Percent with one decimal; "-" when there is no sample. */
function fmtPct(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}%`;
}

/** Human duration (1.2s / 450ms / 3m10s / 2h5m); "-" when unknown. */
function fmtDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

/** Print the scorecard as a caveman-readable table. */
function printTable(report: ScorecardReport): void {
  if (report.agents.length === 0) {
    console.log("no agent activity found");
    return;
  }

  const windowLabel =
    report.windowStart === null
      ? "all time"
      : `since ${new Date(report.windowStart).toISOString().slice(0, 10)}`;
  console.log(
    `AGENT SCORECARD — since=${report.since} (${windowLabel}), agents=${report.agents.length}`,
  );
  console.log("");

  console.log(
    `  ${"agent".padEnd(COL.agent)}${"done".padEnd(COL.done)}${"failed".padEnd(COL.failed)}` +
      `${"blocked".padEnd(COL.blocked)}${"running".padEnd(COL.running)}${"pending".padEnd(COL.pending)}` +
      `${"succ%".padEnd(COL.success)}${"verify%".padEnd(COL.verify)}${"p50".padEnd(COL.p50)}` +
      `${"p95".padEnd(COL.p95)}${"tokens".padEnd(COL.tokens)}${"esc".padEnd(COL.esc)}${"byp".padEnd(COL.byp)}`,
  );

  for (const agent of report.agents) {
    const verify =
      agent.verify.n > 0 ? `${fmtPct(agent.verify.passRate)} (${agent.verify.n})` : "-";
    const tokens = agent.tokensUsed > 0 ? String(agent.tokensUsed) : "-";
    console.log(
      `  ${truncate(agent.agent, COL.agent).padEnd(COL.agent)}` +
        `${String(agent.counts.done).padEnd(COL.done)}` +
        `${String(agent.counts.failed).padEnd(COL.failed)}` +
        `${String(agent.counts.blocked).padEnd(COL.blocked)}` +
        `${String(agent.counts.running).padEnd(COL.running)}` +
        `${String(agent.counts.pending).padEnd(COL.pending)}` +
        `${fmtPct(agent.successRate).padEnd(COL.success)}` +
        `${verify.padEnd(COL.verify)}` +
        `${fmtDuration(agent.duration.p50).padEnd(COL.p50)}` +
        `${fmtDuration(agent.duration.p95).padEnd(COL.p95)}` +
        `${tokens.padEnd(COL.tokens)}` +
        `${String(agent.escalations.length > 0 ? agent.escalations.reduce((n, e) => n + e.count, 0) : 0).padEnd(COL.esc)}` +
        `${String(agent.bypasses).padEnd(COL.byp)}`,
    );
  }

  for (const agent of report.agents) {
    if (agent.failureModes.length > 0) {
      console.log("");
      console.log(`FAILURE MODES — ${agent.agent}`);
      for (const failure of agent.failureModes) {
        console.log(`  ${`${failure.count}x`.padEnd(6)}${failure.mode}`);
      }
    }
    if (agent.escalations.length > 0) {
      console.log("");
      console.log(`ESCALATIONS — ${agent.agent}`);
      for (const escalation of agent.escalations) {
        const source =
          escalation.from === null ? "no source plan" : `from ${shortId(escalation.from)}`;
        console.log(`  ${`${escalation.count}x`.padEnd(6)}${source}`);
      }
    }
  }
}

/** Print the scorecard as JSON. */
function printJson(report: ScorecardReport): void {
  console.log(JSON.stringify(report, null, 2));
}

/** Human window label: "all time" or "since YYYY-MM-DD". */
function windowLabel(windowStart: number | null): string {
  return windowStart === null
    ? "all time"
    : `since ${new Date(windowStart).toISOString().slice(0, 10)}`;
}

/** Print the routing report as caveman-readable sections. */
function printRoutingTable(report: RoutingReport): void {
  console.log(
    `ROUTING EVENTS — since=${report.since} (${windowLabel(report.windowStart)}), total=${report.total}`,
  );
  if (report.total === 0) {
    console.log("");
    console.log("no routing events found");
    return;
  }
  console.log("");

  console.log("SOURCES");
  console.log(
    `  ${"source".padEnd(RCOL.source)}${"count".padEnd(RCOL.count)}${"pct".padEnd(RCOL.pct)}`,
  );
  for (const entry of report.bySource) {
    const pct = fmtPct((entry.count / report.total) * 100);
    console.log(
      `  ${truncate(entry.source, RCOL.source).padEnd(RCOL.source)}` +
        `${String(entry.count).padEnd(RCOL.count)}${pct.padEnd(RCOL.pct)}`,
    );
  }

  console.log("");
  console.log(`fallback=${fmtPct(report.fallbackPct)}  explore=${fmtPct(report.explorePct)}`);

  console.log("");
  console.log("AGENTS (top 10)");
  console.log(`  ${"agent".padEnd(RCOL.agent)}${"count".padEnd(RCOL.count)}`);
  for (const entry of report.byAgent) {
    console.log(
      `  ${truncate(entry.agent, RCOL.agent).padEnd(RCOL.agent)}${String(entry.count).padEnd(RCOL.count)}`,
    );
  }

  console.log("");
  console.log("BUCKETS (top 10)");
  console.log(`  ${"bucket".padEnd(RCOL.bucket)}${"count".padEnd(RCOL.count)}`);
  for (const entry of report.byBucket) {
    console.log(
      `  ${truncate(entry.bucket, RCOL.bucket).padEnd(RCOL.bucket)}${String(entry.count).padEnd(RCOL.count)}`,
    );
  }

  console.log("");
  console.log(
    `COVERAGE  linked=${report.coverage.linked} inferred=${report.coverage.inferred} orphan=${report.coverage.orphan}`,
  );
}

/** Parse CLI args and run. */
export function runStats(args: string[]): void {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.error("error: .ndomo/state.db not found — run from project root or parent dir");
    process.exit(1);
  }

  let asJson = false;
  let since: ScorecardSince = "all";
  let agent: string | undefined;
  let routing = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      asJson = true;
    } else if (arg === "--routing") {
      routing = true;
    } else if (arg === "--since" && i + 1 < args.length) {
      const value = args[i + 1] ?? "";
      i += 1;
      const parsed = parseSince(value);
      if (!parsed) {
        console.error(`error: invalid --since "${value}" — expected 7d | 30d | all`);
        process.exit(1);
      }
      since = parsed;
    } else if (arg === "--agent" && i + 1 < args.length) {
      agent = args[i + 1];
      i += 1;
    }
  }

  const db = new Database(dbPath);

  if (routing) {
    // Routing-events report ONLY — the scorecard is not printed alongside it.
    // --agent does not apply to routing and is intentionally ignored.
    let routingReport: RoutingReport;
    try {
      routingReport = computeRoutingReport(db, { since });
    } finally {
      db.close();
    }
    if (asJson) {
      console.log(JSON.stringify({ routing: routingReport }, null, 2));
    } else {
      printRoutingTable(routingReport);
    }
    return;
  }

  let report: ScorecardReport;
  try {
    report = computeAgentScorecard(db, agent ? { since, agent } : { since });
  } finally {
    db.close();
  }

  if (asJson) {
    printJson(report);
  } else {
    printTable(report);
  }
}

// Direct execution
if (import.meta.main) {
  runStats(process.argv.slice(2));
}
