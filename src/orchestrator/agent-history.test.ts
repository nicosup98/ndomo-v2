/**
 * Tests for agent outcome history: bucket derivation, on-the-fly aggregation
 * and the hierarchical scoring (pooling, recency, verify, duration, cap).
 *
 * Uses in-memory SQLite via bun:sqlite with the full schema applied by
 * runMigrations; no network access.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import {
  type AgentHistory,
  bucketForTask,
  cellKey,
  emptyAgentHistory,
  emptyHistoryCell,
  HISTORY_MAX_ROWS_PER_CELL,
  type HistoryCell,
  intentForAgent,
  loadAgentHistory,
  median,
  scoreAgentForBucket,
  stackFromFiles,
} from "./agent-history.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let db: Database;
let planSeq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  planSeq = 0;
});

interface TaskSeed {
  agent: string;
  status?: "done" | "failed" | "pending" | "running" | "blocked";
  verification?: string;
  files?: string[];
  complexity?: number;
  durationMs?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

function insertTask(seed: TaskSeed): void {
  planSeq += 1;
  const planId = crypto.randomUUID();
  db.query(
    `INSERT INTO plans (id, slug, title, status, priority, created_at, updated_at, overview, complexity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(planId, `plan-${planSeq}`, "test plan", "draft", 3, NOW, NOW, "overview", 3);
  db.query(
    `INSERT INTO plan_tasks
       (id, plan_id, order_index, description, agent, files, complexity, status,
        started_at, completed_at, duration_ms, verification_status, dependencies, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    planId,
    0,
    "seed task",
    seed.agent,
    JSON.stringify(seed.files ?? []),
    seed.complexity ?? 3,
    seed.status ?? "done",
    seed.startedAt ?? null,
    seed.completedAt ?? null,
    seed.durationMs ?? null,
    seed.verification ?? "not_required",
    "[]",
    "{}",
  );
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe("bucket derivation", () => {
  test("stackFromFiles picks the dominant class", () => {
    expect(stackFromFiles(["src/a.ts", "src/b.tsx", "README.md"])).toBe("js");
    expect(stackFromFiles(["src/App.vue", "src/x.ts", "src/y.ts"])).toBe("js");
    expect(stackFromFiles(["src/App.vue", "src/x.ts"])).toBe("vue");
    expect(stackFromFiles(["cmd/main.go"])).toBe("go");
    expect(stackFromFiles(["app/main.py"])).toBe("python");
    expect(stackFromFiles(["lib/lib.rs"])).toBe("rust");
    expect(stackFromFiles(["src/main.zig"])).toBe("zig");
    expect(stackFromFiles(["docs/readme.md", "docs/guide.mdx"])).toBe("docs");
  });

  test("stackFromFiles → generic for empty or unknown extensions", () => {
    expect(stackFromFiles([])).toBe("generic");
    expect(stackFromFiles(["package.json", "Dockerfile"])).toBe("generic");
  });

  test("stackFromFiles tie-breaks deterministically (js before docs)", () => {
    expect(stackFromFiles(["README.md", "src/a.js"])).toBe("js");
  });

  test("intentForAgent maps roles, defaulting to implement", () => {
    expect(intentForAgent("ranger")).toBe("explore");
    expect(intentForAgent("scout")).toBe("explore");
    expect(intentForAgent("chronicler")).toBe("document");
    expect(intentForAgent("scribe")).toBe("research");
    expect(intentForAgent("painter")).toBe("design");
    expect(intentForAgent("critic")).toBe("audit");
    expect(intentForAgent("guild")).toBe("debate");
    expect(intentForAgent("sage")).toBe("debug");
    expect(intentForAgent("craftsman")).toBe("implement");
    expect(intentForAgent("js-smith")).toBe("implement");
  });

  test("bucketForTask combines intent and stack with sane fallbacks", () => {
    expect(bucketForTask("implement", ["src/a.ts"], "js")).toBe("implement:js");
    expect(bucketForTask("implement", [], "go")).toBe("implement:go");
    expect(bucketForTask("implement", [], "unknown")).toBe("implement:generic");
    expect(bucketForTask("document", ["docs/x.md"], undefined)).toBe("document:docs");
    // Files win when they resolve to a known stack.
    expect(bucketForTask("implement", ["src/x.py"], "js")).toBe("implement:python");
  });

  test("median handles odd, even and empty lists", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

// ─── loadAgentHistory ─────────────────────────────────────────────────────────

describe("loadAgentHistory", () => {
  test("aggregates terminal rows into cells/agents/global and excludes non-terminal", () => {
    insertTask({
      agent: "craftsman",
      files: ["src/a.ts"],
      verification: "passed",
      durationMs: 1000,
      completedAt: NOW - DAY_MS,
    });
    insertTask({
      agent: "craftsman",
      status: "failed",
      files: ["src/b.ts"],
      durationMs: 5000,
      completedAt: NOW - 2 * DAY_MS,
    });
    insertTask({
      agent: "js-smith",
      files: ["src/c.ts"],
      completedAt: NOW - 3 * DAY_MS,
      startedAt: NOW - 3 * DAY_MS - 500,
      durationMs: null, // derived from completed_at − started_at
    });
    insertTask({ agent: "craftsman", status: "pending", files: ["src/z.ts"] });
    insertTask({ agent: "craftsman", status: "blocked", files: ["src/z.ts"] });
    insertTask({ agent: "warden", status: "running", files: ["infra/x.yml"] });

    const history = loadAgentHistory(db, { now: NOW });

    expect(history.terminalRows).toBe(3);
    const cell = history.cells.get(cellKey("craftsman", "implement:js"));
    expect(cell?.n).toBe(2);
    expect(cell?.done).toBe(1);
    expect(cell?.failed).toBe(1);
    expect(cell?.verifyPassed).toBe(1);
    expect(cell?.durations.slice().sort((a, b) => a - b)).toEqual([1000, 5000]);
    // done+passed (1.0) with 1-day-old recency; failed contributes 0 weight to success
    expect(cell?.weightedSuccess).toBeCloseTo(0.5 ** (1 / 30), 6);
    expect(cell?.weightSum).toBeCloseTo(0.5 ** (1 / 30) + 0.5 ** (2 / 30), 6);

    expect(history.agents.get("craftsman")?.n).toBe(2);
    expect(history.global.n).toBe(3);

    const jsCell = history.cells.get(cellKey("js-smith", "implement:js"));
    expect(jsCell?.durations).toEqual([500]);
  });

  test("caps rows per cell keeping the most recent", () => {
    for (let i = 0; i < 150; i += 1) {
      insertTask({ agent: "craftsman", files: ["src/a.ts"], completedAt: NOW - i * 60_000 });
    }
    const history = loadAgentHistory(db, { now: NOW });
    const cell = history.cells.get(cellKey("craftsman", "implement:js"));
    expect(cell?.n).toBe(HISTORY_MAX_ROWS_PER_CELL);
    expect(cell?.lastCompletedAt).toBe(NOW);
    expect(history.global.n).toBe(HISTORY_MAX_ROWS_PER_CELL);
    expect(history.terminalRows).toBe(HISTORY_MAX_ROWS_PER_CELL);
  });

  test("malformed files JSON degrades to generic bucket", () => {
    insertTask({ agent: "smith", files: [], completedAt: NOW });
    db.query("UPDATE plan_tasks SET files = ? WHERE agent = 'smith'").run("{not-json");
    const history = loadAgentHistory(db, { now: NOW });
    expect(history.cells.has(cellKey("smith", "implement:generic"))).toBe(true);
  });
});

// ─── scoreAgentForBucket ──────────────────────────────────────────────────────

const buildCell = (over: Partial<HistoryCell>): HistoryCell => ({ ...emptyHistoryCell(), ...over });

const nowCell = (
  successes: number,
  failures: number,
  durationsMs: number[] = [1000],
): HistoryCell =>
  buildCell({
    n: successes + failures,
    done: successes,
    failed: failures,
    weightedSuccess: successes,
    weightSum: successes + failures,
    durations: durationsMs,
    lastCompletedAt: NOW,
  });

function snapshot(
  cells: Array<[string, HistoryCell]>,
  global?: HistoryCell,
  agents?: Array<[string, HistoryCell]>,
): AgentHistory {
  const history = emptyAgentHistory(NOW);
  history.cells = new Map(cells);
  if (global) history.global = global;
  if (agents) history.agents = new Map(agents);
  history.terminalRows = cells.reduce((sum, [, cell]) => sum + cell.n, 0);
  return history;
}

describe("scoreAgentForBucket", () => {
  test("empty history → neutral prior, never NaN", () => {
    const result = scoreAgentForBucket(emptyAgentHistory(NOW), "smith", "implement:js", {
      now: NOW,
    });
    expect(Number.isNaN(result.score)).toBe(false);
    expect(result.pooled).toBeCloseTo(1 / 3, 6);
    expect(result.recency).toBe(0);
    expect(result.verify).toBe(1);
    expect(result.duration).toBe(1);
    expect(result.confidence).toBe(1);
    expect(result.score).toBeCloseTo((1 / 3) * 0.5, 6);
    expect(result.cellN).toBe(0);
    expect(result.agentN).toBe(0);
  });

  test("better outcomes score higher", () => {
    const history = snapshot(
      [
        [cellKey("good", "implement:js"), nowCell(10, 0, [1000])],
        [cellKey("bad", "implement:js"), nowCell(0, 10, [9000])],
      ],
      buildCell({ durations: [1000] }),
    );
    const good = scoreAgentForBucket(history, "good", "implement:js", { now: NOW });
    const bad = scoreAgentForBucket(history, "bad", "implement:js", { now: NOW });
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.score).toBeGreaterThan(0);
    expect(bad.score).toBeLessThan(good.score);
  });

  test("data-poor cells blend toward the parent level", () => {
    const history = snapshot([[cellKey("x", "implement:js"), nowCell(1, 0)]]);
    const result = scoreAgentForBucket(history, "x", "implement:js", { now: NOW });
    // Raw cell estimate would be (1+1)/(3+1) = 0.5; blending pulls it toward the 1/3 prior.
    expect(result.pooled).toBeLessThan(0.5);
    expect(result.pooled).toBeGreaterThan(1 / 3);
  });

  test("verify factor: neutral without samples, pass-rate weighted with samples", () => {
    const noVerify = scoreAgentForBucket(emptyAgentHistory(NOW), "x", "implement:js", {
      complexity: 0.9,
      now: NOW,
    });
    expect(noVerify.verify).toBe(1);

    const passed = snapshot([
      [
        cellKey("x", "implement:js"),
        buildCell({ n: 1, done: 1, verifyPassed: 1, lastCompletedAt: NOW }),
      ],
    ]);
    expect(
      scoreAgentForBucket(passed, "x", "implement:js", { complexity: 0.9, now: NOW }).verify,
    ).toBeCloseTo(1, 6);

    const waivedOnly = snapshot([
      [
        cellKey("x", "implement:js"),
        buildCell({ n: 1, done: 1, verifyWaived: 1, lastCompletedAt: NOW }),
      ],
    ]);
    // passRate = passed/(passed+waived) = 0 when everything was waived
    expect(
      scoreAgentForBucket(waivedOnly, "x", "implement:js", { complexity: 0.9, now: NOW }).verify,
    ).toBeCloseTo(0.6, 6);
    expect(
      scoreAgentForBucket(waivedOnly, "x", "implement:js", { complexity: 0.1, now: NOW }).verify,
    ).toBeCloseTo(0.7, 6);

    const mixed = snapshot([
      [
        cellKey("x", "implement:js"),
        buildCell({ n: 2, done: 2, verifyPassed: 1, verifyWaived: 1, lastCompletedAt: NOW }),
      ],
    ]);
    expect(
      scoreAgentForBucket(mixed, "x", "implement:js", { complexity: 0.9, now: NOW }).verify,
    ).toBeCloseTo(0.8, 6);
    expect(
      scoreAgentForBucket(mixed, "x", "implement:js", { complexity: 0.1, now: NOW }).verify,
    ).toBeCloseTo(0.85, 6);
  });

  test("duration factor discounts slower-than-baseline agents", () => {
    const global = buildCell({ durations: [1000] });
    const slow = snapshot([[cellKey("slow", "implement:js"), nowCell(5, 0, [9000])]], global);
    const fast = snapshot([[cellKey("fast", "implement:js"), nowCell(5, 0, [100])]], global);
    const slowScore = scoreAgentForBucket(slow, "slow", "implement:js", { now: NOW });
    const fastScore = scoreAgentForBucket(fast, "fast", "implement:js", { now: NOW });
    expect(slowScore.duration).toBeGreaterThan(0.7);
    expect(slowScore.duration).toBeLessThan(0.85);
    expect(fastScore.duration).toBeGreaterThan(slowScore.duration);
    expect(fastScore.duration).toBeLessThanOrEqual(1);
  });

  test("recency decays with age (half-life 30 days)", () => {
    const fresh = snapshot([[cellKey("a", "implement:js"), nowCell(1, 0)]]);
    const staleCell = nowCell(1, 0);
    staleCell.lastCompletedAt = NOW - 60 * DAY_MS;
    const stale = snapshot([[cellKey("a", "implement:js"), staleCell]]);
    expect(scoreAgentForBucket(fresh, "a", "implement:js", { now: NOW }).recency).toBeCloseTo(1, 6);
    expect(scoreAgentForBucket(stale, "a", "implement:js", { now: NOW }).recency).toBeCloseTo(
      0.25,
      6,
    );
  });

  test("JEV confidence scales the score", () => {
    const history = snapshot([[cellKey("x", "implement:js"), nowCell(10, 0)]]);
    const low = scoreAgentForBucket(history, "x", "implement:js", {
      jevConfidence: 0,
      now: NOW,
    });
    const high = scoreAgentForBucket(history, "x", "implement:js", {
      jevConfidence: 1,
      now: NOW,
    });
    expect(low.confidence).toBeCloseTo(0.5, 6);
    expect(high.confidence).toBeCloseTo(1, 6);
    expect(high.score).toBeGreaterThan(low.score);
  });
});
