/**
 * ndomo DB — Graceful shutdown handler.
 *
 * Registers process signal handlers to close the database
 * connection cleanly on SIGTERM, SIGINT, or beforeExit.
 */

import type { Database } from "bun:sqlite";
import { closeDb } from "./client.ts";

let registered = false;

export function registerShutdownHandlers(db: Database): void {
  if (registered) return;
  registered = true;
  const cleanup = (): void => {
    try {
      closeDb(db);
    } catch {
      /* ignore — already closed or never opened */
    }
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.once("beforeExit", cleanup);
}
