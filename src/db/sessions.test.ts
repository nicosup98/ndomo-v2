/**
 * Tests for ensureSession — the idempotent FK-integrity helper.
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { ensureSession, getSession } from "./sessions.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

describe("ensureSession", () => {
  test("inserts row when missing", () => {
    const id = crypto.randomUUID();
    ensureSession(db, id, "test goal");

    const row = getSession(db, id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(id);
    expect(row?.goal).toBe("test goal");
    expect(row?.createdBy).toBe("auto");
    // NOT NULL cols must be populated
    expect(row?.startedAt).toBeGreaterThan(0);
    expect(row?.lastCheckpoint).toBeGreaterThan(0);
    expect(row?.state).toEqual({});
    expect(row?.agentHistory).toEqual([]);
  });

  test("is idempotent on existing row with different goal", () => {
    const id = crypto.randomUUID();
    ensureSession(db, id, "goal A");
    ensureSession(db, id, "goal B");

    const row = getSession(db, id);
    expect(row).not.toBeNull();
    // INSERT OR IGNORE — original goal preserved
    expect(row?.goal).toBe("goal A");
  });

  test("respects custom createdBy", () => {
    const id = crypto.randomUUID();
    ensureSession(db, id, "test goal", "test-agent");

    const row = getSession(db, id);
    expect(row).not.toBeNull();
    expect(row?.createdBy).toBe("test-agent");
  });

  test("defaults createdBy to 'auto' when not specified", () => {
    const id = crypto.randomUUID();
    ensureSession(db, id, "test goal");

    const row = getSession(db, id);
    expect(row).not.toBeNull();
    expect(row?.createdBy).toBe("auto");
  });

  test("populates started_at and last_checkpoint with current timestamp", () => {
    const before = Date.now();
    const id = crypto.randomUUID();
    ensureSession(db, id, "timestamp check");
    const after = Date.now();

    const row = getSession(db, id);
    expect(row).not.toBeNull();
    expect(row?.startedAt).toBeGreaterThanOrEqual(before);
    expect(row?.startedAt).toBeLessThanOrEqual(after);
    expect(row?.lastCheckpoint).toBeGreaterThanOrEqual(before);
    expect(row?.lastCheckpoint).toBeLessThanOrEqual(after);
  });
});
