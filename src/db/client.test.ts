/**
 * Tests for openDb() input validation — plan 4dc34202.
 *
 * Validates that openDb rejects invalid projectDir values (empty, "/",
 * relative) with a clear Error BEFORE attempting mkdirSync, and that the
 * happy path (valid absolute path from mkdtempSync) still creates
 * `.ndomo/state.db` with foreign keys enabled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./client.ts";

describe("openDb — input validation", () => {
  test('openDb("") throws clear Error', () => {
    expect(() => openDb("")).toThrow(/invalid projectDir/);
  });

  test('openDb("/") throws clear Error', () => {
    expect(() => openDb("/")).toThrow(/invalid projectDir/);
  });

  test('openDb("./relative") throws clear Error', () => {
    expect(() => openDb("./relative")).toThrow(/invalid projectDir/);
  });

  test("openDb rejects other relative paths", () => {
    expect(() => openDb("relative/no-slash")).toThrow(/invalid projectDir/);
    expect(() => openDb("../parent")).toThrow(/invalid projectDir/);
  });

  test("error message includes the offending value for debuggability", () => {
    try {
      openDb("/");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('"/"');
      expect((err as Error).message).toContain("absolute");
    }
  });
});

describe("openDb — happy path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ndomo-client-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("openDb(valid absolute path) creates .ndomo/state.db", () => {
    const db = openDb(tmpDir);
    const dbPath = join(tmpDir, ".ndomo", "state.db");
    expect(existsSync(dbPath)).toBe(true);
    closeDb(db);
  });

  test("openDb enables PRAGMA foreign_keys = ON", () => {
    const db = openDb(tmpDir);
    const fk = db.query("PRAGMA foreign_keys").get() as Record<string, unknown> | null;
    expect(fk).not.toBeNull();
    expect(fk?.foreign_keys).toBe(1);
    closeDb(db);
  });

  test("openDb is idempotent — second call reuses existing .ndomo dir", () => {
    const db1 = openDb(tmpDir);
    closeDb(db1);
    // Second call on same dir should not throw (mkdirSync recursive is idempotent)
    const db2 = openDb(tmpDir);
    const dbPath = join(tmpDir, ".ndomo", "state.db");
    expect(existsSync(dbPath)).toBe(true);
    closeDb(db2);
  });
});
