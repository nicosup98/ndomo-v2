// ─── Agent History (outcome-aware routing signals) ────────────────────────────
/**
 * Loads terminal `plan_tasks` rows and derives per-agent / per-bucket
 * performance signals used by the scheduler to rerank routing candidates
 * ("history-aware" routing). No schema changes: everything is computed on the
 * fly from columns that already exist (status, verification_status, complexity,
 * files, duration_ms, started_at, completed_at).
 *
 * Guarantees:
 * - `loadAgentHistory` never throws on malformed JSON; bad `files` values fall
 *   back to an empty list.
 * - Callers can safely pass an empty history (`emptyAgentHistory()`): every
 *   agent scores against the neutral global prior and n=0 never produces NaN.
 * - Sparse verify data degrades to a neutral factor (1.0), never breaks.
 * - Deterministic: no randomness; `now` is injectable for tests.
 *
 * Scoring (v1) combines five factors, all in [0,1]:
 *
 *   score = pooledSuccess × recencyFactor × verifyFactor × durationFactor × confidenceFactor
 *
 * where:
 * - `pooledSuccess` — hierarchical beta estimate (cell → agent → global) over
 *   recency-weighted success values. Cells with less than `HISTORY_MIN_CELL_N`
 *   effective weight blend toward their parent level.
 * - `recencyFactor` — `0.5 + 0.5 × 0.5^(ageDays / 30)`; stale evidence never
 *   drops below half of the freshness bonus.
 * - `verifyFactor` — neutral (1.0) when there are no verify samples, otherwise
 *   `0.7 + 0.3 × passRate` (low complexity) or `0.6 + 0.4 × passRate` (≥0.66).
 * - `durationFactor` — neutral (1.0) without duration data, otherwise
 *   `w0 + (1 − w0) × 1/(1 + agentMedian/globalMedian)` with `w0 = 0.7` (low
 *   complexity) or `0.8` (high complexity).
 * - `confidenceFactor` — `0.5 + 0.5 × jevConfidence` (neutral 1.0 when absent).
 *
 * Success values: `failed` → 0; `done` + verify `passed` → 1; `done` + verify
 * `waived` → 0.5; `done` without verify → 0.8. `blocked`, `pending` and
 * `running` rows are excluded entirely (blocked never penalizes an agent).
 */

import type { Database } from "bun:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Recency half-life for success weighting (days). */
export const HISTORY_HALF_LIFE_DAYS = 30;
/** Maximum rows kept per (agent, bucket) cell, most recent first. */
export const HISTORY_MAX_ROWS_PER_CELL = 100;
/** Minimum effective weight before a level is trusted over its parent. */
export const HISTORY_MIN_CELL_N = 5;
/** Beta priors per level: cell → agent → global (alpha, beta). Mean 1/3. */
export const HISTORY_PRIORS = {
  cell: { alpha: 1, beta: 2 },
  agent: { alpha: 2, beta: 4 },
  global: { alpha: 4, beta: 8 },
} as const;
/** Complexity threshold above which durations/verify weigh differently. */
export const HIGH_COMPLEXITY_THRESHOLD = 0.66;

/** Intent inferred for a task type or approximated from an agent's role. */
export type HistoryIntent =
  | "implement"
  | "explore"
  | "research"
  | "design"
  | "debug"
  | "audit"
  | "document"
  | "debate";

/** Coarse stack class derived from the task files. */
export type HistoryStack = "js" | "vue" | "go" | "python" | "rust" | "zig" | "docs" | "generic";

/** Aggregated outcome statistics for one (bucket, level) segment. */
export interface HistoryCell {
  /** Terminal rows considered (done + failed). */
  n: number;
  done: number;
  failed: number;
  /** Σ weight × successValue, with recency weights. */
  weightedSuccess: number;
  /** Σ recency weights. */
  weightSum: number;
  verifyPassed: number;
  verifyWaived: number;
  /** Observed durations in ms (duration_ms ?? completed_at − started_at). */
  durations: number[];
  /** Most recent completion timestamp (ms), or null when unknown. */
  lastCompletedAt: number | null;
}

/** Outcome history snapshot consumed by the scheduler. */
export interface AgentHistory {
  /** Per (agent, bucket) cells keyed by {@link cellKey}. */
  cells: Map<string, HistoryCell>;
  /** Per-agent aggregates (all buckets). */
  agents: Map<string, HistoryCell>;
  /** Global aggregate across every agent and bucket. */
  global: HistoryCell;
  /** Terminal rows included after per-cell caps. */
  terminalRows: number;
  /** Timestamp used to compute recency weights at load time. */
  generatedAt: number;
}

/** Options for {@link loadAgentHistory}. */
export interface AgentHistoryOptions {
  /** Injectable clock (tests). Defaults to `Date.now()`. */
  now?: number;
}

/** Options for {@link scoreAgentForBucket}. */
export interface AgentScoreOptions {
  /** Normalized complexity in [0,1] (JEV score); unknown → low complexity. */
  complexity?: number;
  /** Confidence of the JEV agent pick in [0,1], when available. */
  jevConfidence?: number;
  /** Injectable clock (tests). Defaults to `history.generatedAt`. */
  now?: number;
}

/** Factor breakdown behind one agent's score for a bucket. */
export interface AgentScore {
  agent: string;
  bucket: string;
  /** Final score in [0,1]. */
  score: number;
  /** Hierarchical beta success estimate. */
  pooled: number;
  /** Freshness of the latest evidence in [0,1]. */
  recency: number;
  /** Verify factor (1.0 neutral). */
  verify: number;
  /** Duration factor (1.0 neutral). */
  duration: number;
  /** JEV confidence factor (1.0 neutral). */
  confidence: number;
  /** Rows in the (agent, bucket) cell. */
  cellN: number;
  /** Rows for the agent across all buckets. */
  agentN: number;
  /** Verify samples (passed + waived) considered. */
  verifySamples: number;
  /** Median duration used, or null when unknown. */
  medianDurationMs: number | null;
}

/** Row shape read from `plan_tasks` (only the columns this module uses). */
interface PlanTaskHistoryRow {
  agent: string | null;
  status: string | null;
  verification_status: string | null;
  files: string | null;
  duration_ms: number | null;
  started_at: number | null;
  completed_at: number | null;
}

const AGENT_INTENTS: Record<string, HistoryIntent> = {
  scout: "explore",
  ranger: "explore",
  "ops-scout": "explore",
  chronicler: "document",
  scribe: "research",
  painter: "design",
  inspector: "audit",
  critic: "audit",
  guild: "debate",
  sage: "debug",
};

const EXTENSION_STACKS: ReadonlyArray<{ extensions: readonly string[]; stack: HistoryStack }> = [
  { extensions: [".vue"], stack: "vue" },
  { extensions: [".go"], stack: "go" },
  { extensions: [".py"], stack: "python" },
  { extensions: [".rs"], stack: "rust" },
  { extensions: [".zig"], stack: "zig" },
  { extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], stack: "js" },
  { extensions: [".md", ".mdx", ".txt"], stack: "docs" },
];

/** Deterministic tie-break order for mixed-file buckets. */
const STACK_TIE_ORDER: readonly HistoryStack[] = [
  "vue",
  "go",
  "python",
  "rust",
  "zig",
  "js",
  "docs",
];

/** Declared task stacks that map 1:1 to a history bucket. */
const TASK_STACKS: ReadonlySet<string> = new Set(["js", "vue", "go", "python", "zig"]);

/** Approximate the intent of a historical row from the agent that ran it. */
export function intentForAgent(agent: string): HistoryIntent {
  return AGENT_INTENTS[agent] ?? "implement";
}

/** Derive the dominant stack class from a file list (ties use a fixed order). */
export function stackFromFiles(files: readonly string[]): HistoryStack {
  if (files.length === 0) return "generic";
  const counts = new Map<HistoryStack, number>();
  for (const file of files) {
    const lower = file.toLowerCase();
    for (const { extensions, stack } of EXTENSION_STACKS) {
      if (extensions.some((ext) => lower.endsWith(ext))) {
        counts.set(stack, (counts.get(stack) ?? 0) + 1);
        break;
      }
    }
  }
  let best: HistoryStack = "generic";
  let bestCount = 0;
  for (const stack of STACK_TIE_ORDER) {
    const count = counts.get(stack) ?? 0;
    if (count > bestCount) {
      best = stack;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Stack bucket for an incoming task: files win when they resolve to a known
 * stack; otherwise the declared stack; otherwise `generic`.
 */
export function stackBucketForTask(
  files: readonly string[] | undefined,
  stack: string | undefined,
): HistoryStack {
  if (files && files.length > 0) {
    const derived = stackFromFiles(files);
    if (derived !== "generic") return derived;
  }
  if (stack && TASK_STACKS.has(stack)) return stack as HistoryStack;
  return "generic";
}

/** Bucket key for an incoming task (`intent:stack`). */
export function bucketForTask(
  intent: HistoryIntent,
  files: readonly string[] | undefined,
  stack: string | undefined,
): string {
  return `${intent}:${stackBucketForTask(files, stack)}`;
}

/** Key for a (agent, bucket) cell inside an {@link AgentHistory}. */
export function cellKey(agent: string, bucket: string): string {
  return `${agent}\u0000${bucket}`;
}

/** A fresh, empty cell. Also handy for tests and manual snapshots. */
export function emptyHistoryCell(): HistoryCell {
  return {
    n: 0,
    done: 0,
    failed: 0,
    weightedSuccess: 0,
    weightSum: 0,
    verifyPassed: 0,
    verifyWaived: 0,
    durations: [],
    lastCompletedAt: null,
  };
}

/** An empty history: every agent scores against the global prior. */
export function emptyAgentHistory(now: number = Date.now()): AgentHistory {
  return {
    cells: new Map(),
    agents: new Map(),
    global: emptyHistoryCell(),
    terminalRows: 0,
    generatedAt: now,
  };
}

/** Median of a numeric list, or null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function successValue(status: string | null, verificationStatus: string | null): number {
  if (status === "failed") return 0;
  if (verificationStatus === "passed") return 1;
  if (verificationStatus === "waived") return 0.5;
  return 0.8;
}

function parseFiles(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function recencyWeight(completedAt: number | null, now: number): number {
  if (completedAt === null || !Number.isFinite(completedAt)) return 1;
  const ageDays = Math.max(0, now - completedAt) / DAY_MS;
  return 0.5 ** (ageDays / HISTORY_HALF_LIFE_DAYS);
}

function rowDuration(row: PlanTaskHistoryRow): number | null {
  if (typeof row.duration_ms === "number" && row.duration_ms > 0) return row.duration_ms;
  if (typeof row.started_at === "number" && typeof row.completed_at === "number") {
    const delta = row.completed_at - row.started_at;
    if (delta > 0) return delta;
  }
  return null;
}

/** One parsed terminal row, ready for aggregation. */
interface ParsedRow {
  agent: string;
  bucket: string;
  success: number;
  weight: number;
  verificationStatus: string | null;
  durationMs: number | null;
  completedAt: number | null;
}

function parseRow(row: PlanTaskHistoryRow, now: number): ParsedRow | null {
  if (!row.agent) return null;
  const files = parseFiles(row.files);
  const bucket = `${intentForAgent(row.agent)}:${stackFromFiles(files)}`;
  const completedAt = typeof row.completed_at === "number" ? row.completed_at : null;
  return {
    agent: row.agent,
    bucket,
    success: successValue(row.status, row.verification_status),
    weight: recencyWeight(completedAt, now),
    verificationStatus: row.verification_status,
    durationMs: rowDuration(row),
    completedAt,
  };
}

function accumulate(cell: HistoryCell, row: ParsedRow): void {
  cell.n += 1;
  if (row.success === 0) cell.failed += 1;
  else cell.done += 1;
  cell.weightedSuccess += row.weight * row.success;
  cell.weightSum += row.weight;
  if (row.verificationStatus === "passed") cell.verifyPassed += 1;
  if (row.verificationStatus === "waived") cell.verifyWaived += 1;
  if (row.durationMs !== null) cell.durations.push(row.durationMs);
  if (row.completedAt !== null) {
    cell.lastCompletedAt = Math.max(cell.lastCompletedAt ?? 0, row.completedAt);
  }
}

/**
 * Load terminal `plan_tasks` rows and build an {@link AgentHistory} snapshot.
 *
 * Rows are grouped into (agent, bucket) cells, capped at the
 * {@link HISTORY_MAX_ROWS_PER_CELL} most recent rows per cell, then aggregated
 * at cell, agent and global levels.
 */
export function loadAgentHistory(db: Database, options: AgentHistoryOptions = {}): AgentHistory {
  const now = options.now ?? Date.now();
  const history = emptyAgentHistory(now);

  let rows: PlanTaskHistoryRow[];
  try {
    rows = db
      .query(
        `SELECT agent, status, verification_status, files, duration_ms, started_at, completed_at
           FROM plan_tasks
          WHERE status IN ('done','failed') AND agent IS NOT NULL`,
      )
      .all() as PlanTaskHistoryRow[];
  } catch {
    return history;
  }

  const byCell = new Map<string, ParsedRow[]>();
  for (const raw of rows) {
    const parsed = parseRow(raw, now);
    if (!parsed) continue;
    const key = cellKey(parsed.agent, parsed.bucket);
    const bucketRows = byCell.get(key);
    if (bucketRows) bucketRows.push(parsed);
    else byCell.set(key, [parsed]);
  }

  for (const [key, bucketRows] of byCell) {
    bucketRows.sort((a, b) => (b.completedAt ?? -1) - (a.completedAt ?? -1));
    const cell = emptyHistoryCell();
    for (const row of bucketRows.slice(0, HISTORY_MAX_ROWS_PER_CELL)) {
      accumulate(cell, row);
      history.terminalRows += 1;

      let agentCell = history.agents.get(row.agent);
      if (!agentCell) {
        agentCell = emptyHistoryCell();
        history.agents.set(row.agent, agentCell);
      }
      accumulate(agentCell, row);
      accumulate(history.global, row);
    }
    history.cells.set(key, cell);
  }

  return history;
}

function betaMean(cell: HistoryCell | undefined, alpha: number, beta: number): number {
  const weight = cell ? cell.weightSum : 0;
  const successes = cell ? cell.weightedSuccess : 0;
  return (alpha + successes) / (alpha + beta + weight);
}

/** Blend a child estimate toward its parent when the child is data-poor. */
function blendWithParent(child: number, parent: number, childWeight: number): number {
  return (childWeight * child + HISTORY_MIN_CELL_N * parent) / (childWeight + HISTORY_MIN_CELL_N);
}

/**
 * Score one agent for a bucket using the hierarchical history estimate.
 *
 * Never returns NaN, even with an empty history: every factor degrades to its
 * neutral value and the score rests on the global prior.
 */
export function scoreAgentForBucket(
  history: AgentHistory,
  agent: string,
  bucket: string,
  options: AgentScoreOptions = {},
): AgentScore {
  const now = options.now ?? history.generatedAt;
  const cell = history.cells.get(cellKey(agent, bucket));
  const agentCell = history.agents.get(agent);
  const global = history.global;

  const pooledGlobal = betaMean(global, HISTORY_PRIORS.global.alpha, HISTORY_PRIORS.global.beta);
  const pooledAgentRaw = betaMean(agentCell, HISTORY_PRIORS.agent.alpha, HISTORY_PRIORS.agent.beta);
  const pooledAgent = blendWithParent(pooledAgentRaw, pooledGlobal, agentCell?.weightSum ?? 0);
  const pooledCellRaw = betaMean(cell, HISTORY_PRIORS.cell.alpha, HISTORY_PRIORS.cell.beta);
  const pooled = blendWithParent(pooledCellRaw, pooledAgent, cell?.weightSum ?? 0);

  const lastAt = cell?.lastCompletedAt ?? agentCell?.lastCompletedAt ?? null;
  const recency =
    lastAt === null ? 0 : 0.5 ** (Math.max(0, now - lastAt) / (HISTORY_HALF_LIFE_DAYS * DAY_MS));

  const cellVerifySamples = cell ? cell.verifyPassed + cell.verifyWaived : 0;
  const agentVerifySamples = agentCell ? agentCell.verifyPassed + agentCell.verifyWaived : 0;
  const verifySource =
    cellVerifySamples > 0 ? cell : agentVerifySamples > 0 ? agentCell : undefined;
  const verifySamples = verifySource ? verifySource.verifyPassed + verifySource.verifyWaived : 0;
  const passRate =
    verifySource && verifySamples > 0 ? verifySource.verifyPassed / verifySamples : null;

  const complexity = options.complexity;
  const highComplexity = complexity !== undefined && complexity >= HIGH_COMPLEXITY_THRESHOLD;
  const verify =
    passRate === null ? 1 : highComplexity ? 0.6 + 0.4 * passRate : 0.7 + 0.3 * passRate;

  const cellMedian = cell && cell.durations.length > 0 ? median(cell.durations) : null;
  const agentMedian =
    agentCell && agentCell.durations.length > 0 ? median(agentCell.durations) : null;
  const medianDurationMs = cellMedian ?? agentMedian;
  const baselineMedian = global.durations.length > 0 ? median(global.durations) : null;
  let duration = 1;
  if (medianDurationMs !== null && baselineMedian !== null && baselineMedian > 0) {
    const raw = 1 / (1 + medianDurationMs / baselineMedian);
    duration = highComplexity ? 0.8 + 0.2 * raw : 0.7 + 0.3 * raw;
  }

  const confidence = 0.5 + 0.5 * clamp01(options.jevConfidence ?? 1);

  const score = clamp01(pooled * (0.5 + 0.5 * recency) * verify * duration * confidence);

  return {
    agent,
    bucket,
    score,
    pooled,
    recency,
    verify,
    duration,
    confidence,
    cellN: cell?.n ?? 0,
    agentN: agentCell?.n ?? 0,
    verifySamples,
    medianDurationMs,
  };
}
