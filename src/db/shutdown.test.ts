/**
 * Tests for shutdown.ts — plan fcb12dc5 (memory hygiene, finding #2).
 *
 * Validates that:
 *  - Multiple openDb() calls each get SIGTERM/SIGINT/beforeExit cleanup
 *    (regression: module-level `registered` boolean skipped all but the first).
 *  - unregister(db) explicitly removes a db from cleanup tracking (needed
 *    by tests, hot-reload, and explicit teardown paths).
 *  - process.once is used for SIGTERM/SIGINT so listeners self-remove after
 *    firing (regression: process.on would leak listeners across signals).
 *  - SIGTERM cleanly closes all tracked dbs (verify by attempting use-after-close).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./client.ts";
import { getRegisteredDbCount, registerShutdownHandlers, unregister } from "./shutdown.ts";

describe("shutdown — tracking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ndomo-shutdown-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("registerShutdownHandlers tracks each db in a Set", () => {
    const baseline = getRegisteredDbCount();
    const db1 = openDb(tmpDir);
    const db2 = openDb(join(tmpDir, "sub"));

    registerShutdownHandlers(db1);
    expect(getRegisteredDbCount()).toBe(baseline + 1);

    registerShutdownHandlers(db2);
    expect(getRegisteredDbCount()).toBe(baseline + 2);

    // Calling again with the same db should not double-count (Set semantics).
    registerShutdownHandlers(db1);
    expect(getRegisteredDbCount()).toBe(baseline + 2);

    unregister(db1);
    unregister(db2);
    closeDb(db1);
    closeDb(db2);
  });

  test("unregister(db) removes db from tracking", () => {
    const db = openDb(tmpDir);
    const baseline = getRegisteredDbCount();

    registerShutdownHandlers(db);
    expect(getRegisteredDbCount()).toBe(baseline + 1);

    unregister(db);
    expect(getRegisteredDbCount()).toBe(baseline);

    closeDb(db);
  });

  test("unregister of an untracked db is a no-op (no throw)", () => {
    const db = openDb(tmpDir);
    expect(() => unregister(db)).not.toThrow();
    closeDb(db);
  });
});

describe("shutdown — SIGTERM behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ndomo-shutdown-sigterm-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("SIGTERM closes ALL registered dbs (regression: 2nd db used to leak)", () => {
    const db1 = openDb(tmpDir);
    const db2 = openDb(join(tmpDir, "sub"));
    registerShutdownHandlers(db1);
    registerShutdownHandlers(db2);

    process.emit("SIGTERM" as NodeJS.Signals);

    // Both dbs should now be closed — using them throws.
    expect(() => db1.query("SELECT 1").get()).toThrow();
    expect(() => db2.query("SELECT 1").get()).toThrow();
  });

  test("SIGINT closes ALL registered dbs", () => {
    const db1 = openDb(tmpDir);
    const db2 = openDb(join(tmpDir, "sub"));
    registerShutdownHandlers(db1);
    registerShutdownHandlers(db2);

    process.emit("SIGINT" as NodeJS.Signals);

    expect(() => db1.query("SELECT 1").get()).toThrow();
    expect(() => db2.query("SELECT 1").get()).toThrow();
  });

  test("unregistered db is NOT closed on SIGTERM", () => {
    const db1 = openDb(tmpDir);
    const db2 = openDb(join(tmpDir, "sub"));
    registerShutdownHandlers(db1);
    registerShutdownHandlers(db2);
    unregister(db2);

    process.emit("SIGTERM" as NodeJS.Signals);

    // db1 closed, db2 still usable
    expect(() => db1.query("SELECT 1").get()).toThrow();
    expect(db2.query("SELECT 1").get()).not.toBeNull();

    // Cleanup
    closeDb(db2);
  });

  test("process.once — SIGTERM listeners self-remove after firing (no leak)", () => {
    const db1 = openDb(tmpDir);
    const db2 = openDb(join(tmpDir, "sub"));

    const beforeRegister = process.listenerCount("SIGTERM");
    registerShutdownHandlers(db1);
    registerShutdownHandlers(db2);
    const afterRegister = process.listenerCount("SIGTERM");

    // We added 2 SIGTERM listeners (one per db registration)
    expect(afterRegister - beforeRegister).toBe(2);

    // Emit SIGTERM — both listeners fire cleanup, then process.once removes them
    process.emit("SIGTERM" as NodeJS.Signals);

    const afterEmit = process.listenerCount("SIGTERM");

    // process.once guarantees listeners deregister after firing — count must
    // drop back to pre-registration baseline (no accumulation across signals).
    expect(afterEmit).toBe(beforeRegister);
  });
});
