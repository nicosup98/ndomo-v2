/**
 * Tests for the route-only AgentHistory memo: miss/hit reuse, TTL expiry,
 * in-process invalidation, `now` bypass, never-throw degradation, cache-key
 * isolation between databases, and a coarse performance bench at 20k rows.
 *
 * Uses in-memory SQLite via bun:sqlite (plus temp on-disk DBs where keying
 * matters); no network access.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../db/migrations.ts";
import {
  getAgentHistoryCached,
  HISTORY_CACHE_TTL_MS,
  invalidateAgentHistoryCache,
} from "./agent-history.ts";

const NOW = 1_800_000_000_000;

let db: Database;
let planSeq = 0;

// The memo is module-level state: every test starts and ends from a clean slate.
beforeEach(() => {
  invalidateAgentHistoryCache();
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  planSeq = 0;
});

afterEach(() => {
  invalidateAgentHistoryCache();
  db.close();
});

interface TaskSeed {
  agent: string;
  status?: "done" | "failed" | "pending" | "running" | "blocked";
  verification?: string;
  files?: string[];
  completedAt?: number | null;
}

function insertTask(seed: TaskSeed, target: Database = db): void {
  planSeq += 1;
  const planId = crypto.randomUUID();
  target
    .query(
      `INSERT INTO plans (id, slug, title, status, priority, created_at, updated_at, overview, complexity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(planId, `plan-${planSeq}`, "test plan", "draft", 3, NOW, NOW, "overview", 3);
  target
    .query(
      `INSERT INTO plan_tasks
         (id, plan_id, order_index, description, agent, files, complexity, status,
          started_at, completed_at, duration_ms, verification_status, dependencies, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      planId,
      0,
      "seed task",
      seed.agent,
      JSON.stringify(seed.files ?? []),
      3,
      seed.status ?? "done",
      NOW - 1000,
      seed.completedAt ?? NOW,
      1000,
      seed.verification ?? "not_required",
      "[]",
      "{}",
    );
}

// ─── miss / hit / bypass / invalidation ──────────────────────────────────────

describe("getAgentHistoryCached", () => {
  test("miss then hit with the same snapshot reference", () => {
    insertTask({ agent: "craftsman", files: ["src/a.ts"], completedAt: NOW });

    const first = getAgentHistoryCached(db);
    expect(first.cache).toBe("miss");

    const second = getAgentHistoryCached(db);
    expect(second.cache).toBe("hit");
    expect(second.history).toBe(first.history);
    expect(second.history.generatedAt).toBe(first.history.generatedAt);
    expect(second.history.terminalRows).toBe(1);
  });

  test("TTL: hit inside the window, reload once expired", () => {
    expect(HISTORY_CACHE_TTL_MS).toBe(30_000);

    let t = 1000;
    const clock = (): number => t;

    expect(getAgentHistoryCached(db, { clock }).cache).toBe("miss");

    t += 29_999; // 29 999 ms < 30 000 ms → still fresh
    expect(getAgentHistoryCached(db, { clock }).cache).toBe("hit");

    t += 2; // 30 001 ms ≥ TTL → expired
    expect(getAgentHistoryCached(db, { clock }).cache).toBe("miss");
  });

  test("explicit invalidation forces a reload that reflects new terminal rows", () => {
    insertTask({ agent: "js-smith", files: ["src/a.ts"], completedAt: NOW });
    expect(getAgentHistoryCached(db).cache).toBe("miss");
    expect(getAgentHistoryCached(db).cache).toBe("hit");

    invalidateAgentHistoryCache(db);
    expect(getAgentHistoryCached(db).cache).toBe("miss");

    insertTask({ agent: "go-smith", files: ["cmd/main.go"], completedAt: NOW });
    invalidateAgentHistoryCache(db);
    const fresh = getAgentHistoryCached(db);
    expect(fresh.cache).toBe("miss");
    expect(fresh.history.terminalRows).toBe(2);

    // The no-arg form clears every entry, not just one database.
    invalidateAgentHistoryCache();
    expect(getAgentHistoryCached(db).cache).toBe("miss");
  });

  test("`now` bypasses the memo entirely and never populates it", () => {
    insertTask({ agent: "js-smith", files: ["src/a.ts"], completedAt: NOW });

    const a = getAgentHistoryCached(db, { now: NOW });
    const b = getAgentHistoryCached(db, { now: NOW });
    expect(a.cache).toBe("bypass");
    expect(b.cache).toBe("bypass");
    expect(b.history).not.toBe(a.history);
    expect(b.history.generatedAt).toBe(NOW);

    // Bypass writes nothing: the next plain call is still a cold miss.
    expect(getAgentHistoryCached(db).cache).toBe("miss");
  });

  test("`now` ignores an already-warm entry instead of reporting a hit", () => {
    expect(getAgentHistoryCached(db).cache).toBe("miss");
    expect(getAgentHistoryCached(db).cache).toBe("hit");

    const bypassed = getAgentHistoryCached(db, { now: NOW });
    expect(bypassed.cache).toBe("bypass");
    expect(bypassed.history.generatedAt).toBe(NOW);
  });

  test("malformed files JSON never throws and the memo keeps working", () => {
    insertTask({ agent: "smith", files: [], completedAt: NOW });
    db.query("UPDATE plan_tasks SET files = ? WHERE agent = 'smith'").run("not json");

    expect(() => getAgentHistoryCached(db)).not.toThrow();
    invalidateAgentHistoryCache(db);

    const first = getAgentHistoryCached(db);
    expect(first.cache).toBe("miss");
    expect(first.history.terminalRows).toBe(1);

    const second = getAgentHistoryCached(db);
    expect(second.cache).toBe("hit");
    expect(second.history).toBe(first.history);
  });
});

// ─── cache keying ────────────────────────────────────────────────────────────

describe("history cache keys", () => {
  test("distinct :memory: databases never share a snapshot", () => {
    const dbA = new Database(":memory:");
    const dbB = new Database(":memory:");
    try {
      dbA.exec("PRAGMA foreign_keys = ON");
      dbB.exec("PRAGMA foreign_keys = ON");
      runMigrations(dbA);
      runMigrations(dbB);
      insertTask({ agent: "js-smith", files: ["src/a.ts"], completedAt: NOW }, dbA);

      const a = getAgentHistoryCached(dbA);
      const b = getAgentHistoryCached(dbB);
      expect(a.cache).toBe("miss");
      expect(b.cache).toBe("miss"); // distinct handle → distinct key, never a hit
      expect(a.history.terminalRows).toBe(1);
      expect(b.history.terminalRows).toBe(0);
      expect(b.history).not.toBe(a.history);
    } finally {
      dbA.close();
      dbB.close();
      invalidateAgentHistoryCache();
    }
  });

  test("two handles on the same database file share one memo entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ndomo-history-cache-"));
    let first: Database | undefined;
    let second: Database | undefined;
    try {
      first = new Database(join(dir, "state.db"));
      first.exec("PRAGMA foreign_keys = ON");
      runMigrations(first);
      insertTask({ agent: "craftsman", files: ["src/a.ts"], completedAt: NOW }, first);

      expect(getAgentHistoryCached(first).cache).toBe("miss");

      second = new Database(join(dir, "state.db"));
      const reused = getAgentHistoryCached(second);
      expect(reused.cache).toBe("hit");
      expect(reused.history.terminalRows).toBe(1);
    } finally {
      second?.close();
      first?.close();
      invalidateAgentHistoryCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── bench ───────────────────────────────────────────────────────────────────

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

describe("history cache bench", () => {
  /** Design target for the cold full scan (logged, not enforced). */
  const COLD_P95_TARGET_MS = 50;
  /**
   * Enforced regression bound. The full scan is intrinsic to `loadAgentHistory`
   * (pre-cache behavior) and machine-dependent: a 4-core dev box measures
   * ~49-73ms p95 at 20k rows, so the hard gate keeps CI-safe headroom while the
   * design target stays visible in the printed measurements.
   */
  const COLD_P95_CI_SAFE_MS = 150;

  test("20k terminal rows: cold p95 within the CI-safe bound and hit p95 < 1ms", () => {
    const ROWS = 20_000;
    const AGENTS = ["js-smith", "go-smith", "craftsman", "scout"];
    const FILES_BY_STACK = [["src/app.ts"], ["cmd/main.go"], ["src/App.vue"], ["docs/readme.md"]];
    const dir = mkdtempSync(join(tmpdir(), "ndomo-history-bench-"));
    const benchDb = new Database(join(dir, "bench.db"));
    try {
      benchDb.exec("PRAGMA foreign_keys = ON");
      runMigrations(benchDb);

      // Seed in a single transaction with prepared statements: plans carry the
      // FK and `order_index` stays unique per plan.
      const insertPlan = benchDb.query(
        `INSERT INTO plans (id, slug, title, status, priority, created_at, updated_at, overview, complexity)
           VALUES (?, ?, ?, 'draft', 3, ?, ?, 'overview', 3)`,
      );
      const insertRow = benchDb.query(
        `INSERT INTO plan_tasks
             (id, plan_id, order_index, description, agent, files, complexity, status,
              started_at, completed_at, duration_ms, verification_status, dependencies, metadata)
           VALUES (?, ?, ?, ?, ?, ?, 3, ?, ?, ?, 1500, ?, '[]', '{}')`,
      );
      const planCount = 50;
      const rowsPerPlan = ROWS / planCount;
      benchDb.transaction(() => {
        for (let p = 0; p < planCount; p += 1) {
          const planId = `bench-plan-${p}`;
          insertPlan.run(planId, `bench-${p}`, `bench plan ${p}`, NOW, NOW);
          for (let i = 0; i < rowsPerPlan; i += 1) {
            const index = p * rowsPerPlan + i;
            // Decouple agent and stack rotation so the seed spans every
            // (agent, bucket) cell instead of a 1:1 diagonal.
            const agentIndex = index % AGENTS.length;
            const stackIndex = Math.floor(index / AGENTS.length) % FILES_BY_STACK.length;
            insertRow.run(
              `bench-task-${index}`,
              planId,
              i,
              `bench task ${index}`,
              AGENTS[agentIndex] ?? "smith",
              JSON.stringify(FILES_BY_STACK[stackIndex] ?? ["src/app.ts"]),
              index % 7 === 0 ? "failed" : "done",
              NOW - index * 1000,
              NOW - index * 1000 - 1500,
              index % 3 === 0 ? "passed" : "not_required",
            );
          }
        }
      })();

      // N terminal rows really sit behind the full scan (the snapshot itself
      // caps at HISTORY_MAX_ROWS_PER_CELL per cell, so it reports fewer).
      const seeded = benchDb
        .query("SELECT COUNT(*) AS n FROM plan_tasks WHERE status IN ('done','failed')")
        .get() as { n: number };
      expect(seeded.n).toBe(ROWS);

      // Cold path: full reload, memo dropped before every measurement.
      const cold: number[] = [];
      let snapshotRows = 0;
      for (let i = 0; i < 10; i += 1) {
        invalidateAgentHistoryCache(benchDb);
        const start = performance.now();
        const result = getAgentHistoryCached(benchDb);
        cold.push(performance.now() - start);
        expect(result.cache).toBe("miss");
        expect(result.history.terminalRows).toBeGreaterThan(0);
        snapshotRows = result.history.terminalRows;
      }

      // Warm path: pure memo lookup, 100 consecutive calls.
      const hit: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        const start = performance.now();
        const result = getAgentHistoryCached(benchDb);
        hit.push(performance.now() - start);
        expect(result.cache).toBe("hit");
      }

      const coldP50 = percentile(cold, 50);
      const coldP95 = percentile(cold, 95);
      const hitP50 = percentile(hit, 50);
      const hitP95 = percentile(hit, 95);
      // Machine-dependent: the cold scan can drift above the 50ms design target
      // on slow or loaded runners, so measurements are printed and the enforced
      // gate is the documented CI-safe bound.
      console.log(
        `[agent-history-cache] bench N=${ROWS} (snapshot terminalRows=${snapshotRows}) ` +
          `— cold p50=${coldP50.toFixed(3)}ms p95=${coldP95.toFixed(3)}ms ` +
          `(n=${cold.length}; target<${COLD_P95_TARGET_MS}ms); ` +
          `hit p50=${hitP50.toFixed(3)}ms p95=${hitP95.toFixed(3)}ms (n=${hit.length})`,
      );

      expect(coldP95).toBeLessThan(COLD_P95_CI_SAFE_MS);
      expect(hitP95).toBeLessThan(1);
    } finally {
      invalidateAgentHistoryCache();
      benchDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
