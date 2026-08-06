/**
 * Tests for session continuity ledgers (filesystem-backed, no DB).
 *
 * Covers: session-id sanitization/validation, session→data mapping,
 * markdown serialize/parse round-trip (incl. embedded JSON robustness),
 * directory + path resolution, atomic + idempotent writes, create-vs-
 * overwrite semantics, missing-ledger reads (null), and traversal safety.
 * Plus checkpointSession integration: backwards-compat + ledger write.
 *
 * Uses a fresh tmp project dir per test (mirrors designs.test.ts) and an
 * in-memory SQLite DB for the session-integration suite.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerData } from "./ledgers.ts";
import {
  getLedgerFilePath,
  parseLedgerFromMarkdown,
  readLedger,
  readLedgerRaw,
  resolveLedgerDir,
  sanitizeSessionId,
  serializeLedgerToMarkdown,
  sessionToLedgerData,
  validateSessionId,
  writeLedger,
} from "./ledgers.ts";
import { runMigrations } from "./migrations.ts";
import { createPlan } from "./plans.ts";
import { checkpointSession, getSession, startSession } from "./sessions.ts";
import type { Session } from "./types.ts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ndomo-ledgers-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Build a full LedgerData with sensible defaults + optional overrides. */
function baseData(overrides: Partial<LedgerData> = {}): LedgerData {
  return {
    sessionId: "ses_abc123",
    goal: "ship the ledger feature",
    planId: null,
    state: { phase: "draft", count: 3 },
    keyDecisions: "went with atomic temp+rename",
    agentHistory: [{ agent: "foreman", taskId: null, startedAt: 1_700_000_000_000, endedAt: null }],
    startedAt: 1_700_000_000_000,
    lastCheckpoint: 1_700_000_500_000,
    endedAt: null,
    outcome: null,
    metadata: {},
    ...overrides,
  };
}

// ─── Session id sanitization ─────────────────────────────────────────────────

describe("sanitizeSessionId", () => {
  test("passes through safe ids unchanged", () => {
    expect(sanitizeSessionId("ses_abc123")).toBe("ses_abc123");
    expect(sanitizeSessionId("0123-4567-89ab-cdef")).toBe("0123-4567-89ab-cdef");
  });

  test("collapses unsafe chars to hyphens", () => {
    expect(sanitizeSessionId("ses abc/def")).toBe("ses-abc-def");
    expect(sanitizeSessionId("a.b.c")).toBe("a-b-c");
  });

  test("defeats path traversal", () => {
    expect(sanitizeSessionId("../../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeSessionId("..")).toBe("");
    expect(sanitizeSessionId("/etc/passwd")).toBe("etc-passwd");
  });

  test("collapses runs and trims edges", () => {
    expect(sanitizeSessionId("---a---b---")).toBe("a-b");
  });

  test("empty for all-unsafe input", () => {
    expect(sanitizeSessionId("!!!")).toBe("");
    expect(sanitizeSessionId("   ")).toBe("");
  });

  test("truncates to max length", () => {
    const long = "a".repeat(200);
    expect(sanitizeSessionId(long).length).toBe(128);
  });
});

// ─── Session id validation ───────────────────────────────────────────────────

describe("validateSessionId", () => {
  test("returns sanitized id on success", () => {
    expect(validateSessionId("ses_abc123")).toBe("ses_abc123");
  });

  test("throws on empty string", () => {
    expect(() => validateSessionId("")).toThrow(/cannot be empty/);
  });

  test("throws on whitespace-only", () => {
    expect(() => validateSessionId("   ")).toThrow(/cannot be empty/);
  });

  test("throws when sanitizes to empty", () => {
    expect(() => validateSessionId("!!!")).toThrow(/sanitizes to empty/);
  });
});

// ─── sessionToLedgerData ─────────────────────────────────────────────────────

describe("sessionToLedgerData", () => {
  test("maps all session fields to a portable snapshot", () => {
    const session: Session = {
      id: "ses_xyz",
      startedAt: 1000,
      endedAt: null,
      lastCheckpoint: 2000,
      planId: "plan_1",
      goal: "g",
      state: { a: 1 },
      agentHistory: [{ agent: "x", taskId: "t1", startedAt: 1500, endedAt: 1600 }],
      keyDecisions: "kd",
      createdBy: "auto",
      sourceMessageId: null,
      parentSessionId: null,
      outcome: null,
      metadata: { metrics: { totalTokens: 100 } },
      archivedAt: null,
    };
    const data = sessionToLedgerData(session);
    expect(data).toEqual({
      sessionId: "ses_xyz",
      goal: "g",
      planId: "plan_1",
      state: { a: 1 },
      keyDecisions: "kd",
      agentHistory: [{ agent: "x", taskId: "t1", startedAt: 1500, endedAt: 1600 }],
      startedAt: 1000,
      lastCheckpoint: 2000,
      endedAt: null,
      outcome: null,
      metadata: { metrics: { totalTokens: 100 } },
    });
  });

  test("does not mutate the input session", () => {
    const session = baseData() as unknown as Session;
    const before = JSON.stringify(session);
    sessionToLedgerData(session);
    expect(JSON.stringify(session)).toBe(before);
  });
});

// ─── Markdown serialize / parse round-trip ───────────────────────────────────

describe("serializeLedgerToMarkdown + parseLedgerFromMarkdown", () => {
  test("round-trips a full snapshot", () => {
    const data = baseData();
    const md = serializeLedgerToMarkdown(data, 1_800_000_000_000);
    const parsed = parseLedgerFromMarkdown(md);
    expect(parsed).toEqual(data);
  });

  test("round-trips with null key decisions and empty history", () => {
    const data = baseData({ keyDecisions: null, agentHistory: [] });
    const md = serializeLedgerToMarkdown(data, 1_800_000_000_000);
    const parsed = parseLedgerFromMarkdown(md);
    expect(parsed).toEqual(data);
  });

  test("markdown includes human-readable header", () => {
    const data = baseData();
    const md = serializeLedgerToMarkdown(data, 1_800_000_000_000);
    expect(md).toContain("# Session Ledger: ses_abc123");
    expect(md).toContain(`**Goal:** ${data.goal}`);
    expect(md).toContain("## State");
    expect(md).toContain("## Key Decisions");
    expect(md).toContain("## Agent History (1)");
  });

  test("survives triple backticks inside state JSON", () => {
    // The serialize step escapes ``` so the embedded fence stays intact.
    const data = baseData({ state: { code: "```dangerous```" } });
    const md = serializeLedgerToMarkdown(data, 1);
    const parsed = parseLedgerFromMarkdown(md);
    expect(parsed).toEqual(data);
    expect(parsed?.state.code).toBe("```dangerous```");
  });

  test("parse returns null when data block is absent", () => {
    expect(parseLedgerFromMarkdown("# Just a header\n\nno block here")).toBeNull();
  });

  test("parse returns null when JSON is malformed", () => {
    const md = `# x\n\n${"<!-- ndomo:ledger-data -->"}\n\`\`\`json\n{not json\n\`\`\`\n${"<!-- /ndomo:ledger-data -->"}`;
    expect(parseLedgerFromMarkdown(md)).toBeNull();
  });
});

// ─── Directory + path resolution ─────────────────────────────────────────────

describe("resolveLedgerDir / getLedgerFilePath", () => {
  test("resolveLedgerDir returns .ndomo/ledgers and creates it", () => {
    const dir = resolveLedgerDir(projectDir);
    expect(dir).toBe(join(projectDir, ".ndomo", "ledgers"));
    expect(existsSync(dir)).toBe(true);
  });

  test("getLedgerFilePath sanitizes id and stays under ledgers dir", () => {
    const path = getLedgerFilePath(projectDir, "ses_abc123");
    expect(path).toBe(join(projectDir, ".ndomo", "ledgers", "ses_abc123.md"));
  });

  test("getLedgerFilePath neutralizes traversal input", () => {
    const path = getLedgerFilePath(projectDir, "../../../etc/passwd");
    expect(path).toBe(join(projectDir, ".ndomo", "ledgers", "etc-passwd.md"));
    expect(path).not.toContain("..");
  });
});

// ─── writeLedger ─────────────────────────────────────────────────────────────

describe("writeLedger", () => {
  test("creates a new file on first write", () => {
    const res = writeLedger(projectDir, baseData());
    expect(res.created).toBe(true);
    expect(res.sessionId).toBe("ses_abc123");
    expect(res.filePath).toBe(join(projectDir, ".ndomo", "ledgers", "ses_abc123.md"));
    expect(res.byteSize).toBeGreaterThan(0);
    expect(existsSync(res.filePath)).toBe(true);
  });

  test("marks created=false on overwrite", () => {
    writeLedger(projectDir, baseData());
    const res2 = writeLedger(projectDir, baseData({ goal: "updated goal" }));
    expect(res2.created).toBe(false);
  });

  test("is idempotent — same data yields stable bytes modulo updatedAt", () => {
    const r1 = writeLedger(projectDir, baseData());
    const r2 = writeLedger(projectDir, baseData());
    // updatedAt differs (Date.now), but the data payload is identical.
    const md1 = readFileSync(r1.filePath, "utf-8");
    const md2 = readFileSync(r2.filePath, "utf-8");
    // Both parse back to the same data (round-trip stable).
    expect(parseLedgerFromMarkdown(md1)).toEqual(parseLedgerFromMarkdown(md2));
  });

  test("overwrites with new content on data change", () => {
    writeLedger(projectDir, baseData({ goal: "first" }));
    writeLedger(projectDir, baseData({ goal: "second" }));
    const parsed = readLedger(projectDir, "ses_abc123");
    expect(parsed?.goal).toBe("second");
  });

  test("throws on empty session id", () => {
    expect(() => writeLedger(projectDir, baseData({ sessionId: "" }))).toThrow(/cannot be empty/);
  });

  test("sanitizes session id in the filename", () => {
    const res = writeLedger(projectDir, baseData({ sessionId: "ses with space" }));
    expect(res.filePath).toBe(join(projectDir, ".ndomo", "ledgers", "ses-with-space.md"));
  });
});

// ─── readLedger / readLedgerRaw ──────────────────────────────────────────────

describe("readLedger / readLedgerRaw", () => {
  test("readLedger returns null when missing", () => {
    expect(readLedger(projectDir, "ses_missing")).toBeNull();
  });

  test("readLedgerRaw returns null when missing", () => {
    expect(readLedgerRaw(projectDir, "ses_missing")).toBeNull();
  });

  test("readLedger parses a written ledger", () => {
    const data = baseData();
    writeLedger(projectDir, data);
    expect(readLedger(projectDir, "ses_abc123")).toEqual(data);
  });

  test("readLedgerRaw returns the exact written markdown", () => {
    const data = baseData();
    const res = writeLedger(projectDir, data);
    const raw = readLedgerRaw(projectDir, "ses_abc123");
    expect(raw).not.toBeNull();
    expect(raw).toBe(readFileSync(res.filePath, "utf-8"));
  });

  test("readLedger sanitizes the requested id", () => {
    writeLedger(projectDir, baseData({ sessionId: "ses_abc123" }));
    // Requesting with a traversal-ish id still resolves to the same file.
    expect(readLedger(projectDir, "ses_abc123///")).not.toBeNull();
  });
});

// ─── checkpointSession integration (DB + ledger) ─────────────────────────────

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

describe("checkpointSession ledger integration", () => {
  test("backwards-compatible: 4-arg call writes NO ledger", () => {
    const sid = startSession(db, { id: "ses_legacy", goal: "g" }).id;
    const res = checkpointSession(db, sid, { x: 1 });
    expect(res).not.toBeNull();
    // No projectDir → no ledger directory created at all.
    expect(existsSync(join(projectDir, ".ndomo", "ledgers"))).toBe(false);
  });

  test("writes ledger when opts.projectDir is provided", () => {
    const sid = startSession(db, { id: "ses_ledger", goal: "persist me" }).id;
    const res = checkpointSession(db, sid, { phase: "executing" }, "decided X", {
      projectDir,
    });
    expect(res).not.toBeNull();
    const parsed = readLedger(projectDir, "ses_ledger");
    expect(parsed).not.toBeNull();
    expect(parsed?.goal).toBe("persist me");
    expect(parsed?.state).toEqual({ phase: "executing" });
    expect(parsed?.keyDecisions).toBe("decided X");
  });

  test("reflects the full session state including agent history", () => {
    // Create a real plan so the sessions.plan_id FK is satisfied.
    createPlan(db, {
      id: "p1",
      slug: "ledger-test",
      title: "T",
      status: "draft",
      priority: 1,
      approvedAt: null,
      completedAt: null,
      sessionId: null,
      overview: "o",
      approach: null,
      complexity: 1,
      createdBy: "test",
      updatedBy: "test",
      sourceSessionId: null,
      sourceMessageId: null,
      category: null,
      owner: "foreman",
      metadata: {},
      archivedAt: null,
    });
    const sid = startSession(db, { id: "ses_full", goal: "g", planId: "p1" }).id;
    checkpointSession(db, sid, { n: 1 }, undefined, { projectDir });
    const parsed = readLedger(projectDir, "ses_full");
    expect(parsed?.planId).toBe("p1");
    expect(parsed?.sessionId).toBe("ses_full");
    expect(parsed?.startedAt).toBeGreaterThan(0);
  });

  test("returns null and writes no ledger when session does not exist", () => {
    const res = checkpointSession(db, "ses_nope", { x: 1 }, undefined, { projectDir });
    expect(res).toBeNull();
    expect(readLedger(projectDir, "ses_nope")).toBeNull();
  });

  test("DB update stays authoritative even if ledger dir is unwritable", () => {
    // The DB write succeeds; the best-effort ledger failure is swallowed.
    const sid = startSession(db, { id: "ses_db_ok", goal: "g" }).id;
    // Point projectDir at a path under a non-existent root that cannot be
    // created — mkdir recursive will still succeed actually, so instead we
    // pass a projectDir whose .ndomo is a regular file (mkdir throws).
    const badFile = join(projectDir, "blocker");
    writeFileSyncTest(badFile); // create a regular file where a dir is expected
    const res = checkpointSession(db, sid, { x: 1 }, undefined, {
      projectDir: badFile,
    });
    // Session still updated in DB.
    expect(res).not.toBeNull();
    expect(getSession(db, sid)?.state).toEqual({ x: 1 });
  });

  test("opts.context resolves project dir when projectDir absent", () => {
    const sid = startSession(db, { id: "ses_ctx", goal: "g" }).id;
    checkpointSession(db, sid, { x: 1 }, undefined, { context: { directory: projectDir } });
    expect(readLedger(projectDir, "ses_ctx")).not.toBeNull();
  });

  test("opts.context with invalid path skips ledger silently", () => {
    const sid = startSession(db, { id: "ses_badctx", goal: "g" }).id;
    // directory="/" is invalid → resolveProjectDir falls back to cwd.
    // To force a skip we give a context that resolves to a blocker file.
    const badFile = join(projectDir, "blocker2");
    writeFileSyncTest(badFile);
    const res = checkpointSession(db, sid, { x: 1 }, undefined, {
      context: { worktree: badFile },
    });
    // worktree is "valid" (absolute, non-root) so it is used; the ledger
    // write then fails on mkdir → swallowed. DB still authoritative.
    expect(res).not.toBeNull();
    expect(getSession(db, sid)?.state).toEqual({ x: 1 });
  });
});

/** Drop a regular file at `path` (used to force mkdir failures downstream). */
function writeFileSyncTest(path: string): void {
  writeFileSync(path, "block");
}
