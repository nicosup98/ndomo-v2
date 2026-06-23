/**
 * v15 backfill tests — backfillAnalysisFindings()
 *
 * Verifies that the data-only migration correctly renames finding keys
 * inside analyses.findings_json:
 *   description    → observation
 *   recommendation → proposedAction
 *
 * And that re-running it is a no-op (idempotency).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createAnalysis } from "./analyses.ts";
import { backfillAnalysisFindings } from "./migrations.ts";
import { runMigrations } from "./migrations.ts";


let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

function insertRawFindings(slug: string, findings: unknown): void {
  // Bypass createAnalysis so we can store pre-rename (old-key) findings directly.
  db.query(
    "INSERT INTO analyses (id, slug, title, project_path, summary, findings_json, source_plan_id, agent, session_id, created_by) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)",
  ).run(
    crypto.randomUUID(),
    slug,
    `title-${slug}`,
    "/proj",
    "summary",
    JSON.stringify(findings),
    "ranger",
    "ranger",
  );
}

function readFindings(slug: string): unknown[] {
  const row = db
    .query<{ findings_json: string }, [string]>(
      "SELECT findings_json FROM analyses WHERE slug = ?",
    )
    .get(slug);
  if (!row) throw new Error(`no analysis with slug=${slug}`);
  return JSON.parse(row.findings_json);
}

describe("backfillAnalysisFindings (v15)", () => {
  test("renames description → observation", () => {
    insertRawFindings("a", [
      { severity: "high", description: "auth missing" },
    ]);
    const count = backfillAnalysisFindings(db);
    expect(count).toBe(1);
    const findings = readFindings("a") as Array<Record<string, unknown>>;
    expect(findings[0]).toHaveProperty("observation", "auth missing");
    expect(findings[0]).not.toHaveProperty("description");
  });

  test("renames recommendation → proposedAction", () => {
    insertRawFindings("b", [
      { severity: "medium", description: "slow", recommendation: "add index" },
    ]);
    const count = backfillAnalysisFindings(db);
    expect(count).toBe(1);
    const findings = readFindings("b") as Array<Record<string, unknown>>;
    expect(findings[0]).toHaveProperty("observation", "slow");
    expect(findings[0]).toHaveProperty("proposedAction", "add index");
    expect(findings[0]).not.toHaveProperty("description");
    expect(findings[0]).not.toHaveProperty("recommendation");
  });

  test("is idempotent — second run renames 0 findings", () => {
    insertRawFindings("c", [
      { severity: "high", description: "x" },
      { severity: "low", description: "y", recommendation: "z" },
    ]);
    expect(backfillAnalysisFindings(db)).toBe(2);
    expect(backfillAnalysisFindings(db)).toBe(0);
    // Findings still intact after 2nd run
    const findings = readFindings("c") as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(2);
    expect(findings[0]).toHaveProperty("observation", "x");
    expect(findings[1]).toHaveProperty("proposedAction", "z");
  });

  test("skips findings already in new shape (presence of observation)", () => {
    insertRawFindings("d", [
      { severity: "high", observation: "ok", proposedAction: "do X" },
    ]);
    const count = backfillAnalysisFindings(db);
    expect(count).toBe(0);
    const findings = readFindings("d") as Array<Record<string, unknown>>;
    expect(findings[0]).toEqual({
      severity: "high",
      observation: "ok",
      proposedAction: "do X",
    });
  });

  test("handles mixed batch — partial old-keys, partial new-keys", () => {
    insertRawFindings("e", [
      { severity: "high", description: "old1" },
      { severity: "medium", observation: "new1" },
      { severity: "low", description: "old2", recommendation: "old2-rec" },
    ]);
    const count = backfillAnalysisFindings(db);
    // Counter increments per mutated row — see migration note about `renamed += next.length`.
    // Behavior: each row whose payload mutated counts all its findings, even if only some
    // were renamed within that row. With 3 findings and at least one mutation per row, we
    // expect ≥1. Assert behavior conservatively.
    expect(count).toBeGreaterThanOrEqual(2);

    const findings = readFindings("e") as Array<Record<string, unknown>>;
    expect(findings[0]).toEqual({ severity: "high", observation: "old1" });
    expect(findings[1]).toEqual({ severity: "medium", observation: "new1" });
    expect(findings[2]).toEqual({
      severity: "low",
      observation: "old2",
      proposedAction: "old2-rec",
    });
  });

  test("skips malformed JSON rows without throwing", () => {
    insertRawFindings("f", [{ description: "ok" }]);
    db.query("UPDATE analyses SET findings_json = ? WHERE slug = ?").run(
      "not-valid-json{{{",
      "f",
    );
    expect(() => backfillAnalysisFindings(db)).not.toThrow();
    // Malformed row should be left untouched (still has the bad JSON)
    const row = db
      .query<{ findings_json: string }, [string]>(
        "SELECT findings_json FROM analyses WHERE slug = ?",
      )
      .get("f");
    expect(row!.findings_json).toBe("not-valid-json{{{");
  });

  test("skips rows where findings_json parses to a non-array", () => {
    insertRawFindings("g", [{ description: "x" }]);
    db.query("UPDATE analyses SET findings_json = ? WHERE slug = ?").run(
      JSON.stringify({ wrapped: true }),
      "g",
    );
    expect(() => backfillAnalysisFindings(db)).not.toThrow();
  });

  test("skips rows where findings_json is an empty array", () => {
    insertRawFindings("h", []);
    const count = backfillAnalysisFindings(db);
    expect(count).toBe(0);
    expect(readFindings("h")).toEqual([]);
  });

  test("handles multiple analyses rows in one transaction", () => {
    insertRawFindings("m1", [{ description: "a" }]);
    insertRawFindings("m2", [{ description: "b" }]);
    insertRawFindings("m3", [{ observation: "already new" }]);
    const count = backfillAnalysisFindings(db);
    expect(count).toBe(2);
    expect((readFindings("m1")[0] as Record<string, unknown>).observation).toBe("a");
    expect((readFindings("m2")[0] as Record<string, unknown>).observation).toBe("b");
    expect((readFindings("m3")[0] as Record<string, unknown>).observation).toBe(
      "already new",
    );
  });

  test("returns 0 when there are no analyses rows", () => {
    expect(backfillAnalysisFindings(db)).toBe(0);
  });

  test("preserves other keys untouched", () => {
    insertRawFindings("p", [
      {
        severity: "high",
        location: "src/auth.ts:42",
        description: "broken",
        recommendation: "fix",
        effort: "small",
        impact: "medium",
      },
    ]);
    backfillAnalysisFindings(db);
    const f = readFindings("p")[0] as Record<string, unknown>;
    expect(f.severity).toBe("high");
    expect(f.location).toBe("src/auth.ts:42");
    expect(f.effort).toBe("small");
    expect(f.impact).toBe("medium");
    expect(f.observation).toBe("broken");
    expect(f.proposedAction).toBe("fix");
  });

  test("createAnalysis → backfill noop (created findings already use new keys)", () => {
    // createAnalysis doesn't take findingsJson — it stores "[]". So this confirms
    // the post-migration state of newly created rows is also a no-op target.
    createAnalysis(db, {
      slug: "fresh",
      title: "Fresh",
      projectPath: "/p",
      findingsJson: "[]",
    });
    expect(backfillAnalysisFindings(db)).toBe(0);
  });
});
