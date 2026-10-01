/**
 * Tests for src/cli/stats.ts — CLI stats command (agent scorecard).
 *
 * Uses a temp-file SQLite DB with full migrations (pattern copied from
 * status.test.ts): the DB lives in <tmp>/.ndomo/state.db and `process.chdir`
 * into the temp dir so resolveDbPath() picks it up.
 *
 * Tests:
 * 1. Empty DB → prints "no agent activity found"
 * 2. Mixed-status tasks → correct counts, success rate, verify %, p50/p95, tokens
 * 3. --json → valid JSON with the full scorecard shape
 * 4. --since 7d → rows older than the window are excluded (default = all)
 * 5. --agent → isolates a single agent
 * 6. Escalations (slug escalation-*) + metadata.verificationBypass are counted
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../db/migrations.ts";
import { recordRoutingEvent } from "../db/routing-events.ts";
import { runStats } from "./stats.ts";

let db: Database;
let dbPath: string;
let tmpDir: string;

interface TaskFixture {
  agent: string;
  status: string;
  verificationStatus?: string;
  error?: string | null;
  durationMs?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  tokensUsed?: number | null;
  metadata?: string;
}

/** Create a test plan directly in DB. */
function insertPlan(
  id: string,
  slug: string,
  title: string,
  status: string,
  options: { createdAt?: number; metadata?: string; createdBy?: string } = {},
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO plans (id, slug, title, status, priority, created_at, updated_at, session_id, overview, complexity, created_by, updated_by, metadata)
     VALUES (?, ?, ?, ?, 2, ?, ?, NULL, 'test', 3, ?, ?, ?)`,
  ).run(
    id,
    slug,
    title,
    status,
    options.createdAt ?? now,
    now,
    options.createdBy ?? "test",
    options.createdBy ?? "test",
    options.metadata ?? "{}",
  );
}

/** Insert a task fixture for a plan. */
function insertTask(planId: string, orderIndex: number, fixture: TaskFixture): void {
  db.query(
    `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status,
       verification_status, error, started_at, completed_at, duration_ms, tokens_used,
       created_by, updated_by, metadata)
     VALUES (?, ?, ?, 'test task', ?, '[]', 3, ?, ?, ?, ?, ?, ?, ?, 'test', 'test', ?)`,
  ).run(
    crypto.randomUUID(),
    planId,
    orderIndex,
    fixture.agent,
    fixture.status,
    fixture.verificationStatus ?? "not_required",
    fixture.error ?? null,
    fixture.startedAt ?? null,
    fixture.completedAt ?? null,
    fixture.durationMs ?? null,
    fixture.tokensUsed ?? null,
    fixture.metadata ?? "{}",
  );
}

/** Capture console output during a function call. */
function captureConsole(fn: () => void): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { stdout, stderr };
}

/** Run runStats() with cwd set to the temp project (DB already closed). */
function runInProject(args: string[]): { stdout: string; stderr: string } {
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    return captureConsole(() => runStats(args));
  } finally {
    process.chdir(origCwd);
  }
}

/** Pull the single agent out of a parsed scorecard (fails loudly when absent). */
function firstAgent<T>(report: { agents: T[] }): T {
  const agent = report.agents[0];
  if (!agent) throw new Error("expected at least one agent in scorecard");
  return agent;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-stats-"));
  const ndomoDir = join(tmpDir, ".ndomo");
  mkdirSync(ndomoDir, { recursive: true });
  dbPath = join(ndomoDir, "state.db");
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("stats CLI", () => {
  test("empty DB prints 'no agent activity found'", () => {
    db.close();
    const { stdout } = runInProject([]);
    expect(stdout).toContain("no agent activity found");
  });

  test("counts, success rate, verify %, percentiles and tokens", () => {
    const planId = crypto.randomUUID();
    insertPlan(planId, "score-plan", "Score Plan", "executing");
    insertTask(planId, 0, {
      agent: "js-smith",
      status: "done",
      verificationStatus: "passed",
      durationMs: 1000,
      tokensUsed: 100,
      completedAt: Date.now(),
    });
    insertTask(planId, 1, {
      agent: "js-smith",
      status: "done",
      verificationStatus: "not_required",
      durationMs: 2000,
      tokensUsed: 200,
      completedAt: Date.now(),
    });
    insertTask(planId, 2, {
      agent: "js-smith",
      status: "failed",
      error: "Error: typecheck failed\n    at run (tsc.js:1)",
      durationMs: 3000,
      tokensUsed: 300,
      completedAt: Date.now(),
    });
    insertTask(planId, 3, { agent: "js-smith", status: "blocked" });
    insertTask(planId, 4, { agent: "js-smith", status: "running", startedAt: Date.now() });
    db.close();

    const { stdout } = runInProject(["--json"]);
    const parsed = JSON.parse(stdout) as {
      since: string;
      agents: Array<{
        agent: string;
        counts: Record<string, number>;
        successRate: number | null;
        verify: { passed: number; waived: number; n: number; passRate: number | null };
        duration: { p50: number | null; p95: number | null; n: number };
        tokensUsed: number;
        failureModes: Array<{ mode: string; count: number }>;
        escalations: Array<{ from: string | null; count: number }>;
        bypasses: number;
      }>;
    };

    expect(parsed.since).toBe("all");
    expect(parsed.agents).toHaveLength(1);
    const smith = firstAgent(parsed);
    expect(smith.agent).toBe("js-smith");
    expect(smith.counts).toMatchObject({
      done: 2,
      failed: 1,
      blocked: 1,
      running: 1,
      pending: 0,
      total: 5,
    });
    // (1.0 passed + 0.8 unverified + 0 failed) / 3 = 60%
    expect(smith.successRate).toBe(60);
    expect(smith.verify).toEqual({ passed: 1, waived: 0, n: 1, passRate: 100 });
    expect(smith.duration).toEqual({ p50: 2000, p95: 3000, n: 3 });
    expect(smith.tokensUsed).toBe(600);
    expect(smith.failureModes).toEqual([{ mode: "Error: typecheck failed", count: 1 }]);
    expect(smith.escalations).toEqual([]);
    expect(smith.bypasses).toBe(0);
  });

  test("default output is a readable table", () => {
    const planId = crypto.randomUUID();
    insertPlan(planId, "table-plan", "Table Plan", "executing");
    insertTask(planId, 0, {
      agent: "warden",
      status: "done",
      verificationStatus: "waived",
      durationMs: 1500,
      tokensUsed: 42,
      completedAt: Date.now(),
    });
    db.close();

    const { stdout } = runInProject([]);
    expect(stdout).toContain("AGENT SCORECARD");
    expect(stdout).toContain("warden");
    expect(stdout).toContain("50.0%");
    expect(stdout).not.toContain("{");
  });

  test("--json outputs valid JSON with since=7d window", () => {
    const planId = crypto.randomUUID();
    insertPlan(planId, "json-plan", "JSON Plan", "executing");
    insertTask(planId, 0, { agent: "ranger", status: "done", completedAt: Date.now() });
    db.close();

    const { stdout } = runInProject(["--json", "--since", "7d"]);
    const parsed = JSON.parse(stdout) as {
      since: string;
      windowStart: number | null;
      generatedAt: number;
      agents: Array<{ agent: string }>;
    };
    expect(parsed.since).toBe("7d");
    expect(typeof parsed.windowStart).toBe("number");
    expect(parsed.windowStart).toBeLessThan(parsed.generatedAt);
    expect(parsed.agents.map((a) => a.agent)).toEqual(["ranger"]);
  });

  test("--since 7d excludes rows older than the window (default includes them)", () => {
    const planId = crypto.randomUUID();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    insertPlan(planId, "window-plan", "Window Plan", "executing");
    insertTask(planId, 0, {
      agent: "sage",
      status: "failed",
      error: "old failure",
      startedAt: thirtyDaysAgo,
      completedAt: thirtyDaysAgo,
    });
    insertTask(planId, 1, {
      agent: "sage",
      status: "failed",
      error: "recent failure",
      startedAt: Date.now() - 60_000,
      completedAt: Date.now(),
    });
    db.close();

    const all = JSON.parse(runInProject(["--json"]).stdout) as {
      agents: Array<{
        counts: { failed: number };
        failureModes: Array<{ mode: string; count: number }>;
      }>;
    };
    expect(firstAgent(all).counts.failed).toBe(2);
    expect(firstAgent(all).failureModes).toHaveLength(2);

    const recent = JSON.parse(runInProject(["--json", "--since", "7d"]).stdout) as {
      agents: Array<{
        counts: { failed: number };
        failureModes: Array<{ mode: string; count: number }>;
      }>;
    };
    expect(firstAgent(recent).counts.failed).toBe(1);
    expect(firstAgent(recent).failureModes).toEqual([{ mode: "recent failure", count: 1 }]);
  });

  test("--agent isolates a single agent", () => {
    const planId = crypto.randomUUID();
    insertPlan(planId, "multi-agent", "Multi Agent", "executing");
    insertTask(planId, 0, { agent: "js-smith", status: "done", completedAt: Date.now() });
    insertTask(planId, 1, {
      agent: "warden",
      status: "failed",
      error: "boom",
      completedAt: Date.now(),
    });
    db.close();

    const parsed = JSON.parse(runInProject(["--json", "--agent", "warden"]).stdout) as {
      agents: Array<{ agent: string; counts: { failed: number } }>;
    };
    expect(parsed.agents).toHaveLength(1);
    expect(firstAgent(parsed).agent).toBe("warden");
    expect(firstAgent(parsed).counts.failed).toBe(1);
  });

  test("escalations and verification bypasses are attributed per agent", () => {
    const planId = crypto.randomUUID();
    insertPlan(planId, "bypass-host", "Bypass Host", "executing");
    insertTask(planId, 0, {
      agent: "js-smith",
      status: "done",
      verificationStatus: "waived",
      completedAt: Date.now(),
      metadata: JSON.stringify({
        verificationBypass: { forceReason: "legacy", forcedBy: "foreman", forcedAt: 1 },
      }),
    });

    insertPlan(crypto.randomUUID(), "escalation-abc12345", "Escalation: flaky test", "draft", {
      metadata: JSON.stringify({
        escalatedFrom: "plan-source-1",
        escalatedBy: "craftsman",
        reason: "flaky test",
      }),
      createdBy: "foreman",
    });
    insertPlan(crypto.randomUUID(), "escalation-def67890", "Escalation: no source", "draft", {
      metadata: JSON.stringify({ escalatedFrom: null, escalatedBy: "craftsman" }),
      createdBy: "foreman",
    });
    insertPlan(crypto.randomUUID(), "plan-bypass", "Plan Bypass", "executing", {
      metadata: JSON.stringify({
        verificationBypass: { forceReason: "manual", forcedBy: "foreman", forcedAt: 2 },
      }),
      createdBy: "foreman",
    });
    db.close();

    const parsed = JSON.parse(runInProject(["--json"]).stdout) as {
      agents: Array<{
        agent: string;
        bypasses: number;
        escalations: Array<{ from: string | null; count: number }>;
      }>;
    };
    const byAgent = new Map(parsed.agents.map((a) => [a.agent, a]));

    const craftsman = byAgent.get("craftsman");
    expect(craftsman).toBeDefined();
    expect(craftsman?.escalations).toEqual([
      { from: null, count: 1 },
      { from: "plan-source-1", count: 1 },
    ]);

    const foreman = byAgent.get("foreman");
    expect(foreman?.bypasses).toBe(1);

    const smith = byAgent.get("js-smith");
    expect(smith?.bypasses).toBe(1);
    expect(smith?.escalations).toEqual([]);
  });

  test("--agent filters plan-level signals too", () => {
    insertPlan(crypto.randomUUID(), "escalation-xyz12345", "Escalation: solo", "draft", {
      metadata: JSON.stringify({ escalatedFrom: null, escalatedBy: "craftsman" }),
      createdBy: "foreman",
    });
    db.close();

    const parsed = JSON.parse(runInProject(["--json", "--agent", "foreman"]).stdout) as {
      agents: Array<{ agent: string }>;
    };
    expect(parsed.agents).toEqual([]);
  });
});

describe("stats CLI --routing", () => {
  test("--routing prints the routing table without the scorecard", () => {
    recordRoutingEvent(db, {
      agent: "js-smith",
      source: "rules",
      intent: "implement",
      stack: "js",
    });
    recordRoutingEvent(db, {
      agent: "js-smith",
      source: "rules",
      intent: "implement",
      stack: "js",
      fallback: true,
    });
    db.close();

    const { stdout } = runInProject(["--routing"]);
    expect(stdout).toContain("ROUTING EVENTS");
    expect(stdout).toContain("since=all");
    expect(stdout).toContain("total=2");
    expect(stdout).not.toContain("AGENT SCORECARD");
    expect(stdout).toContain("SOURCES");
    expect(stdout).toContain("rules");
    expect(stdout).toContain("fallback=50.0%");
    expect(stdout).toContain("explore=0.0%");
    expect(stdout).toContain("implement:js");
    expect(stdout).toContain("linked=0 inferred=0 orphan=2");
  });

  test("--routing --json returns { routing: { total, bySource, coverage } }", () => {
    recordRoutingEvent(db, {
      agent: "warden",
      source: "jev",
      intent: "audit",
      stack: "generic",
    });
    db.close();

    const parsed = JSON.parse(runInProject(["--routing", "--json"]).stdout) as {
      routing: {
        since: string;
        total: number;
        bySource: Array<{ source: string; count: number }>;
        byAgent: Array<{ agent: string; count: number }>;
        coverage: { linked: number; inferred: number; orphan: number };
      };
    };
    expect(parsed.routing.since).toBe("all");
    expect(parsed.routing.total).toBe(1);
    expect(parsed.routing.bySource).toEqual([{ source: "jev", count: 1 }]);
    expect(parsed.routing.byAgent).toEqual([{ agent: "warden", count: 1 }]);
    expect(parsed.routing.coverage).toEqual({ linked: 0, inferred: 0, orphan: 1 });
  });

  test("--routing --since 7d filters older events (default = all)", () => {
    recordRoutingEvent(db, {
      agent: "old-agent",
      source: "rules",
      intent: "explore",
      createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    recordRoutingEvent(db, { agent: "recent-agent", source: "jev", intent: "explore" });
    db.close();

    const all = JSON.parse(runInProject(["--routing", "--json"]).stdout) as {
      routing: { total: number };
    };
    expect(all.routing.total).toBe(2);

    const week = JSON.parse(runInProject(["--routing", "--json", "--since", "7d"]).stdout) as {
      routing: { total: number; byAgent: Array<{ agent: string; count: number }> };
    };
    expect(week.routing.total).toBe(1);
    expect(week.routing.byAgent).toEqual([{ agent: "recent-agent", count: 1 }]);
  });

  test("--routing on an empty DB reports 'no routing events found'", () => {
    db.close();
    const { stdout } = runInProject(["--routing"]);
    expect(stdout).toContain("ROUTING EVENTS");
    expect(stdout).toContain("total=0");
    expect(stdout).toContain("no routing events found");
    expect(stdout).not.toContain("AGENT SCORECARD");
  });

  test("--routing ignores --agent (routing report is always full)", () => {
    recordRoutingEvent(db, { agent: "js-smith", source: "rules", intent: "implement" });
    recordRoutingEvent(db, { agent: "warden", source: "rules", intent: "audit" });
    db.close();

    const parsed = JSON.parse(
      runInProject(["--routing", "--json", "--agent", "warden"]).stdout,
    ) as {
      routing: { total: number };
    };
    expect(parsed.routing.total).toBe(2);
  });
});
