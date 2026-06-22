/**
 * Tests for resolveProjectDir() — plan bb805ff9.
 *
 * Validates the full resolution chain: worktree → directory → process.cwd(),
 * including the pgadmin bug scenario (ctx.directory="/" → cwd fallback).
 * Uses mkdtempSync + process.chdir for deterministic cwd mocking; original
 * cwd is always restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectDir } from "./resolve-project-dir.ts";

describe("resolveProjectDir", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "ndomo-resolve-test-"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Happy path: worktree / directory precedence ─────────────────────────

  test("(a) worktree wins over directory + cwd", () => {
    process.chdir(tmpDir);
    const result = resolveProjectDir({
      worktree: "/home/user/worktree",
      directory: "/home/user/project",
    });
    expect(result).toBe("/home/user/worktree");
  });

  test("(b) directory wins when worktree is undefined", () => {
    process.chdir(tmpDir);
    const result = resolveProjectDir({
      worktree: undefined,
      directory: "/home/user/project",
    });
    expect(result).toBe("/home/user/project");
  });

  test("(b2) directory wins when worktree is empty string", () => {
    process.chdir(tmpDir);
    const result = resolveProjectDir({
      worktree: "",
      directory: "/home/user/project",
    });
    expect(result).toBe("/home/user/project");
  });

  test("(b3) directory wins when worktree is '/' (invalid)", () => {
    process.chdir(tmpDir);
    const result = resolveProjectDir({
      worktree: "/",
      directory: "/home/user/project",
    });
    expect(result).toBe("/home/user/project");
  });

  // ─── Fallback to process.cwd() ───────────────────────────────────────────

  test("(c) cwd fallback when directory is '/' (pgadmin bug)", () => {
    process.chdir(tmpDir);
    const result = resolveProjectDir({
      worktree: undefined,
      directory: "/",
    });
    expect(result).toBe(tmpDir);
  });

  test("(c2) cwd fallback is silent (no console.warn)", () => {
    process.chdir(tmpDir);
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const result = resolveProjectDir({ worktree: undefined, directory: "/" });
      expect(result).toBe(tmpDir);
      expect(warnings.length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("(d) cwd fallback when directory is undefined", () => {
    process.chdir(tmpDir);
    const result = resolveProjectDir({
      worktree: undefined,
      directory: undefined,
    });
    expect(result).toBe(tmpDir);
  });

  test("(e) cwd fallback when directory is empty string", () => {
    process.chdir(tmpDir);
    const result = resolveProjectDir({
      worktree: undefined,
      directory: "",
    });
    expect(result).toBe(tmpDir);
  });

  test("(e2) cwd fallback when both worktree and directory are '/'", () => {
    process.chdir(tmpDir);
    const result = resolveProjectDir({
      worktree: "/",
      directory: "/",
    });
    expect(result).toBe(tmpDir);
  });

  // ─── Total failure ───────────────────────────────────────────────────────

  test("(f) throws when even cwd is invalid ('/')", () => {
    process.chdir("/");
    expect(() =>
      resolveProjectDir({
        worktree: undefined,
        directory: "/",
      }),
    ).toThrow(/no valid project directory/);
  });

  test("(f2) throws when both ctx paths and cwd are all invalid", () => {
    process.chdir("/");
    expect(() =>
      resolveProjectDir({
        worktree: "/",
        directory: "",
      }),
    ).toThrow(/no valid project directory/);
  });
});
