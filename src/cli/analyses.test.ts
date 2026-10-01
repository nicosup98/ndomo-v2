/**
 * Tests for src/cli/analyses.ts — CLI analyses command.
 *
 * Same pattern as status.test.ts: create a real .ndomo/state.db in a temp dir
 * and `process.chdir` into it so `resolveDbPath()` picks it up. Console output
 * is captured around `runAnalyses()` (DB error paths call `process.exit`, so
 * only safe paths — help/list/get/search — are exercised).
 *
 * Tests:
 * 1. help prints usage without touching the DB
 * 2. list prints the inserted analysis row
 * 3. get <id> prints parseable JSON for the analysis
 * 4. search <query> finds the analysis by summary text
 * 5. registration: `bun src/cli/index.ts analyses list` exits 0 (not "unknown command")
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnalysis } from "../db/analyses.ts";
import { runMigrations } from "../db/migrations.ts";
import { runAnalyses } from "./analyses.ts";

let tmpDir: string;
let analysisId: string;

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

/** Run fn with cwd pointed at the temp project. */
function withTempCwd<T>(fn: () => T): T {
  const origCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    return fn();
  } finally {
    process.chdir(origCwd);
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-analyses-"));
  mkdirSync(join(tmpDir, ".ndomo"), { recursive: true });
  const db = new Database(join(tmpDir, ".ndomo", "state.db"));
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const analysis = createAnalysis(db, {
    slug: "smoke-analysis",
    title: "Smoke Analysis",
    projectPath: "/tmp/fixture-project",
    summary: "cli coverage fixture",
    findingsJson: "[]",
    agent: "ranger",
  });
  analysisId = analysis.id;
  db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("analyses CLI", () => {
  test("help prints usage without requiring a DB", () => {
    const { stdout } = captureConsole(() => runAnalyses(["--help"]));
    expect(stdout).toContain("Usage: ndomo analyses");
    expect(stdout).toContain("list");
    expect(stdout).toContain("search");
  });

  test("list prints the inserted analysis", () => {
    const { stdout, stderr } = withTempCwd(() => captureConsole(() => runAnalyses(["list"])));
    expect(stderr).toBe("");
    expect(stdout).toContain("smoke-analysis");
    expect(stdout).toContain("Smoke Analysis");
  });

  test("get <id> prints analysis JSON", () => {
    const { stdout } = withTempCwd(() => captureConsole(() => runAnalyses(["get", analysisId])));
    const parsed = JSON.parse(stdout) as { slug: string; id: string };
    expect(parsed.id).toBe(analysisId);
    expect(parsed.slug).toBe("smoke-analysis");
  });

  test("search <query> finds the analysis", () => {
    const { stdout } = withTempCwd(() => captureConsole(() => runAnalyses(["search", "coverage"])));
    expect(stdout).toContain("smoke-analysis");
  });

  test("index.ts registers `analyses` (subprocess, not unknown command)", async () => {
    const repoRoot = join(import.meta.dir, "../..");
    const { spawnSync } = await import("bun");
    const result = spawnSync({
      cmd: ["bun", "run", join(repoRoot, "src/cli/index.ts"), "analyses", "list"],
      cwd: tmpDir,
    });
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).not.toContain("unknown command");
    expect(stdout).toContain("smoke-analysis");
  });
});
