/**
 * Agent Scorecard — per-agent performance aggregates over the ndomo state DB.
 *
 * Shared core behind the `ndomo stats` CLI (`src/cli/stats.ts`) and the MCP
 * `stats` tool (`src/plugin.ts`): callers own the `bun:sqlite` handle, so the
 * aggregation stays synchronous, pure and unit-testable against a temp DB.
 *
 * Success semantics mirror `src/orchestrator/agent-history.ts` (the scheduler's
 * source of truth): `failed` → 0, `done` + verify `passed` → 1, `done` + verify
 * `waived` → 0.5, `done` without verify → 0.8. `blocked`, `pending` and
 * `running` rows never enter the success rate — blocked must not penalize an
 * agent (design trade-off F2).
 *
 * History is inclusive by default: archived plans/tasks are part of the
 * scorecard (full history). `since: "7d" | "30d"` windows on
 * `COALESCE(completed_at, started_at)` for tasks and `created_at` for plans;
 * rows without any timestamp only show up under `since: "all"`.
 */

import type { Database } from "bun:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Window presets accepted by `--since` / the `stats` tool. */
export type ScorecardSince = "7d" | "30d" | "all";

/** Every window value, exported for CLI validation. */
export const SCORECARD_SINCE_VALUES: readonly ScorecardSince[] = ["7d", "30d", "all"] as const;

/** Days behind each non-`all` window. */
const SINCE_DAYS: Record<Exclude<ScorecardSince, "all">, number> = { "7d": 7, "30d": 30 };

/**
 * Success weight per terminal outcome. Mirrors the private `successValue()` in
 * `src/orchestrator/agent-history.ts` (not exported there) so CLI/tool and
 * scheduler agree on what "success" means.
 */
export const SUCCESS_WEIGHT = {
  failed: 0,
  donePassed: 1,
  doneWaived: 0.5,
  doneUnverified: 0.8,
} as const;

/** Failure-mode normalization budget (first line, ~80 chars). */
const FAILURE_MODE_MAX_CHARS = 80;
/** How many failure modes are kept per agent. */
const TOP_FAILURE_MODES = 3;
/** Plan slug prefix that marks an escalation stub (see `escalateToForeman`). */
const ESCALATION_SLUG_PREFIX = "escalation-";

/** Per-status task counts (pending included for completeness). */
export interface AgentCounts {
  done: number;
  failed: number;
  blocked: number;
  running: number;
  pending: number;
  total: number;
}

/** Verification pass rate over `passed`/`waived` verdicts. */
export interface VerifyStats {
  passed: number;
  waived: number;
  /** Sample size = passed + waived. */
  n: number;
  /** 0–100, or null when there is no sample. */
  passRate: number | null;
}

/** Duration percentiles over rows with a computable duration. */
export interface DurationStats {
  p50: number | null;
  p95: number | null;
  /** Rows that contributed a duration. */
  n: number;
}

/** One normalized failure mode with its occurrence count. */
export interface FailureMode {
  mode: string;
  count: number;
}

/** Escalation stubs grouped by their source plan (`metadata.escalatedFrom`). */
export interface EscalationGroup {
  /** Source plan id, or null when the escalation declared no source. */
  from: string | null;
  count: number;
}

/** Everything the scorecard knows about a single agent. */
export interface AgentScorecard {
  agent: string;
  counts: AgentCounts;
  /** 0–100 rounded to one decimal over done+failed rows; null when n=0. */
  successRate: number | null;
  verify: VerifyStats;
  duration: DurationStats;
  /** Σ `plan_tasks.tokens_used` over the window. */
  tokensUsed: number;
  /** Top 3 normalized failure modes (failed rows with an error message). */
  failureModes: FailureMode[];
  /** Escalation stubs attributed to this agent, grouped by source plan. */
  escalations: EscalationGroup[];
  /** Tasks + plans carrying `metadata.verificationBypass`. */
  bypasses: number;
}

/** Full scorecard report (the JSON payload of CLI `--json` / the MCP tool). */
export interface ScorecardReport {
  since: ScorecardSince;
  /** Epoch-ms lower bound of the window, or null for `since: "all"`. */
  windowStart: number | null;
  generatedAt: number;
  agents: AgentScorecard[];
}

/** Options accepted by {@link computeAgentScorecard}. */
export interface AgentScorecardOptions {
  since?: ScorecardSince;
  /** Restrict every metric to a single agent. */
  agent?: string;
  /** Injectable clock (tests). Defaults to `Date.now()`. */
  now?: number;
}

interface TaskStatRow {
  agent: string;
  status: string;
  verification_status: string | null;
  error: string | null;
  duration_ms: number | null;
  started_at: number | null;
  completed_at: number | null;
  tokens_used: number | null;
  metadata: string | null;
}

interface PlanStatRow {
  id: string;
  slug: string;
  metadata: string | null;
  created_at: number;
  created_by: string | null;
}

/** Mutable per-agent accumulator used while folding rows. */
interface AgentAccumulator {
  agent: string;
  counts: AgentCounts;
  successWeighted: number;
  successSamples: number;
  verifyPassed: number;
  verifyWaived: number;
  durations: number[];
  tokensUsed: number;
  failureModes: Map<string, number>;
  escalations: Map<string | null, number>;
  bypasses: number;
}

function emptyCounts(): AgentCounts {
  return { done: 0, failed: 0, blocked: 0, running: 0, pending: 0, total: 0 };
}

function accumulatorFor(agents: Map<string, AgentAccumulator>, agent: string): AgentAccumulator {
  const existing = agents.get(agent);
  if (existing) return existing;
  const fresh: AgentAccumulator = {
    agent,
    counts: emptyCounts(),
    successWeighted: 0,
    successSamples: 0,
    verifyPassed: 0,
    verifyWaived: 0,
    durations: [],
    tokensUsed: 0,
    failureModes: new Map(),
    escalations: new Map(),
    bypasses: 0,
  };
  agents.set(agent, fresh);
  return fresh;
}

/** Round to one decimal place (percentages). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Nearest-rank percentile over an already-filtered list; null when empty. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const clamped = Math.min(Math.max(rank, 1), sorted.length);
  return sorted[clamped - 1] ?? null;
}

/**
 * Normalize a task error into a failure-mode key: trimmed first line,
 * truncated to {@link FAILURE_MODE_MAX_CHARS} chars (ellipsis included).
 * Returns null when there is nothing signal-bearing to aggregate.
 */
export function normalizeFailureMode(error: string): string | null {
  const firstLine = error.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= FAILURE_MODE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, FAILURE_MODE_MAX_CHARS - 3)}...`;
}

/**
 * Duration for one task row: `duration_ms` when present and positive,
 * otherwise `completed_at − started_at` (same rule as agent-history.ts).
 */
function rowDurationMs(row: TaskStatRow): number | null {
  if (
    typeof row.duration_ms === "number" &&
    Number.isFinite(row.duration_ms) &&
    row.duration_ms > 0
  ) {
    return row.duration_ms;
  }
  if (typeof row.started_at === "number" && typeof row.completed_at === "number") {
    const delta = row.completed_at - row.started_at;
    if (delta > 0) return delta;
  }
  return null;
}

/** Success weight for one row; null when the row is not terminal (excluded). */
function successWeight(status: string, verificationStatus: string | null): number | null {
  if (status === "failed") return SUCCESS_WEIGHT.failed;
  if (status === "done") {
    if (verificationStatus === "passed") return SUCCESS_WEIGHT.donePassed;
    if (verificationStatus === "waived") return SUCCESS_WEIGHT.doneWaived;
    return SUCCESS_WEIGHT.doneUnverified;
  }
  return null;
}

/** Parse a JSON column defensively (malformed data degrades to null). */
function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when the JSON blob carries a non-empty `verificationBypass` audit. */
function hasVerificationBypass(raw: string | null): boolean {
  const metadata = parseJsonObject(raw);
  return Boolean(metadata?.verificationBypass);
}

/** Effective agent for an escalation plan: `metadata.escalatedBy` → `created_by`. */
function escalationAgent(
  metadata: Record<string, unknown> | null,
  createdBy: string | null,
): string {
  const escalatedBy = metadata?.escalatedBy;
  if (typeof escalatedBy === "string" && escalatedBy.length > 0) return escalatedBy;
  return createdBy ?? "unknown";
}

/** Source plan of an escalation: `metadata.escalatedFrom` when it is a string. */
function escalationSource(metadata: Record<string, unknown> | null): string | null {
  const source = metadata?.escalatedFrom;
  return typeof source === "string" && source.length > 0 ? source : null;
}

function buildTaskWhere(
  options: AgentScorecardOptions,
  windowStart: number | null,
): {
  sql: string;
  params: Array<string | number>;
} {
  const clauses = ["agent IS NOT NULL"];
  const params: Array<string | number> = [];
  if (options.agent) {
    clauses.push("agent = ?");
    params.push(options.agent);
  }
  if (windowStart !== null) {
    clauses.push("COALESCE(completed_at, started_at) >= ?");
    params.push(windowStart);
  }
  return { sql: clauses.join(" AND "), params };
}

function buildPlanWhere(windowStart: number | null): {
  sql: string;
  params: number[];
} {
  if (windowStart === null) return { sql: "1 = 1", params: [] };
  return { sql: "created_at >= ?", params: [windowStart] };
}

function topFailureModes(counts: Map<string, number>): FailureMode[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_FAILURE_MODES)
    .map(([mode, count]) => ({ mode, count }));
}

function finalize(agent: AgentAccumulator): AgentScorecard {
  const successRate =
    agent.successSamples > 0 ? round1((agent.successWeighted / agent.successSamples) * 100) : null;

  const verifyN = agent.verifyPassed + agent.verifyWaived;
  const passRate = verifyN > 0 ? round1((agent.verifyPassed / verifyN) * 100) : null;

  // count desc, then "no source plan" first, then source id asc (deterministic).
  const escalations: EscalationGroup[] = [...agent.escalations.entries()]
    .sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      if (a[0] === b[0]) return 0;
      if (a[0] === null) return -1;
      if (b[0] === null) return 1;
      return a[0].localeCompare(b[0]);
    })
    .map(([from, count]) => ({ from, count }));

  return {
    agent: agent.agent,
    counts: agent.counts,
    successRate,
    verify: { passed: agent.verifyPassed, waived: agent.verifyWaived, n: verifyN, passRate },
    duration: {
      p50: percentile(agent.durations, 50),
      p95: percentile(agent.durations, 95),
      n: agent.durations.length,
    },
    tokensUsed: agent.tokensUsed,
    failureModes: topFailureModes(agent.failureModes),
    escalations,
    bypasses: agent.bypasses,
  };
}

/**
 * Compute the per-agent scorecard for a state DB.
 *
 * Includes archived rows (full history); use `options.since` to window and
 * `options.agent` to isolate a single agent. Deterministic: agent ordering is
 * `total` desc then name asc, and every sub-list is explicitly sorted.
 */
export function computeAgentScorecard(
  db: Database,
  options: AgentScorecardOptions = {},
): ScorecardReport {
  const now = options.now ?? Date.now();
  const since: ScorecardSince = options.since ?? "all";
  const windowStart = since === "all" ? null : now - SINCE_DAYS[since] * DAY_MS;

  const agents = new Map<string, AgentAccumulator>();

  const taskWhere = buildTaskWhere(options, windowStart);
  const taskRows = db
    .query(
      `SELECT agent, status, verification_status, error, duration_ms, started_at, completed_at,
              tokens_used, metadata
         FROM plan_tasks
        WHERE ${taskWhere.sql}`,
    )
    .all(...taskWhere.params) as TaskStatRow[];

  for (const row of taskRows) {
    const acc = accumulatorFor(agents, row.agent);
    acc.counts.total += 1;
    if (row.status === "done") acc.counts.done += 1;
    else if (row.status === "failed") acc.counts.failed += 1;
    else if (row.status === "blocked") acc.counts.blocked += 1;
    else if (row.status === "running") acc.counts.running += 1;
    else if (row.status === "pending") acc.counts.pending += 1;

    const weight = successWeight(row.status, row.verification_status);
    if (weight !== null) {
      acc.successSamples += 1;
      acc.successWeighted += weight;
    }

    if (row.verification_status === "passed") acc.verifyPassed += 1;
    if (row.verification_status === "waived") acc.verifyWaived += 1;

    const duration = rowDurationMs(row);
    if (duration !== null) acc.durations.push(duration);

    if (typeof row.tokens_used === "number" && Number.isFinite(row.tokens_used)) {
      acc.tokensUsed += row.tokens_used;
    }

    if (row.status === "failed" && row.error) {
      const mode = normalizeFailureMode(row.error);
      if (mode) acc.failureModes.set(mode, (acc.failureModes.get(mode) ?? 0) + 1);
    }

    if (hasVerificationBypass(row.metadata)) acc.bypasses += 1;
  }

  // Plan-level signals (escalations + bypasses) share one scan of `plans`.
  const planWhere = buildPlanWhere(windowStart);
  const planRows = db
    .query(
      `SELECT id, slug, metadata, created_at, created_by
         FROM plans
        WHERE ${planWhere.sql}`,
    )
    .all(...planWhere.params) as PlanStatRow[];

  for (const row of planRows) {
    const metadata = parseJsonObject(row.metadata);
    const isEscalation = row.slug.startsWith(ESCALATION_SLUG_PREFIX);
    const isBypass = hasVerificationBypass(row.metadata);
    if (!isEscalation && !isBypass) continue;

    const attributed = isEscalation
      ? escalationAgent(metadata, row.created_by)
      : (row.created_by ?? "unknown");
    if (options.agent && attributed !== options.agent) continue;

    const acc = accumulatorFor(agents, attributed);
    if (isEscalation) {
      const source = escalationSource(metadata);
      acc.escalations.set(source, (acc.escalations.get(source) ?? 0) + 1);
    }
    if (isBypass) acc.bypasses += 1;
  }

  const finalized = [...agents.values()]
    .map(finalize)
    .sort((a, b) => b.counts.total - a.counts.total || a.agent.localeCompare(b.agent));

  return { since, windowStart, generatedAt: now, agents: finalized };
}
