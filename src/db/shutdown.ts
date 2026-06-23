/**
 * ndomo DB — Graceful shutdown handler.
 *
 * Tracks every Database returned by openDb() in a module-level Set so each
 * connection gets SIGTERM/SIGINT/beforeExit cleanup. Replaces the previous
 * module-level `registered` boolean which silently skipped every call after
 * the first (resulting in leaked file handles on hot-reload, smoke tests,
 * and CLI tools running alongside the plugin).
 *
 * Signal handlers use `process.once` so listeners self-remove after firing —
 * prevents listener accumulation when multiple dbs register in sequence.
 */

import type { Database } from "bun:sqlite";
import { closeDb } from "./client.ts";

const registeredDbs = new Set<Database>();

export function registerShutdownHandlers(db: Database): void {
  if (registeredDbs.has(db)) return;
  registeredDbs.add(db);

  const cleanup = (): void => {
    for (const tracked of registeredDbs) {
      try {
        closeDb(tracked);
      } catch {
        /* ignore — already closed or never opened */
      }
    }
    registeredDbs.clear();
  };

  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  process.once("beforeExit", cleanup);
}

export function unregister(db: Database): void {
  registeredDbs.delete(db);
}

export function getRegisteredDbCount(): number {
  return registeredDbs.size;
}
