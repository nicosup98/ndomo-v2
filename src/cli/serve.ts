#!/usr/bin/env bun
/**
 * ndomo serve — start the HTTP server.
 *
 * Usage:
 *   bun run src/cli/serve.ts [options]
 *
 * Options:
 *   --port <n>       Port number (default: from config, 4097)
 *   --no-auth        Disable HTTP basic auth requirement
 *   --cors <origins> Comma-separated allowed origins (default: from config, "*")
 *   --force          Start even when NDOMO_HTTP_ENABLED is not "true"
 *
 * Examples:
 *   bun run src/cli/serve.ts
 *   bun run src/cli/serve.ts --port 8080 --no-auth
 *   bun run src/cli/serve.ts --cors "https://app.example.com,https://admin.example.com"
 *   bun run src/cli/serve.ts --force --port 4098
 *
 * Graceful shutdown on SIGINT/SIGTERM.
 * Exit codes: 0 = clean shutdown, 1 = startup failure.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpConfig } from "../config/schema.ts";
import { loadHttpConfig } from "../config/schema.ts";
import { runMigrations } from "../db/migrations.ts";
import { type HttpServerHandle, startHttpServer } from "../http/server.ts";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";

/** Resolve DB path — same logic as src/db/client.ts. */
function resolveDbPath(): string | null {
  const cwdPath = join(process.cwd(), NDOMO_DIR, DB_FILE);
  if (existsSync(cwdPath)) return cwdPath;

  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
    const candidate = join(dir, NDOMO_DIR, DB_FILE);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Parse CLI args into a partial config override. */
function parseArgs(args: string[]): {
  port?: number;
  authRequired?: boolean;
  corsOrigins?: string[];
  force: boolean;
} {
  const result: { port?: number; authRequired?: boolean; corsOrigins?: string[]; force: boolean } =
    {
      force: false,
    };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && i + 1 < args.length) {
      const portStr = args[++i];
      if (!portStr) {
        console.error("error: --port requires a value");
        process.exit(1);
      }
      const port = Number(portStr);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.error(`error: invalid port "${portStr}". Must be 1-65535.`);
        process.exit(1);
      }
      result.port = port;
    } else if (arg === "--no-auth") {
      result.authRequired = false;
    } else if (arg === "--cors" && i + 1 < args.length) {
      const corsStr = args[++i];
      if (!corsStr) {
        console.error("error: --cors requires a value");
        process.exit(1);
      }
      result.corsOrigins = corsStr.split(",").map((s) => s.trim());
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`ndomo serve — start the HTTP server

Options:
  --port <n>       Port number (default: from config, 4097)
  --no-auth        Disable HTTP basic auth requirement
  --cors <origins> Comma-separated allowed origins (default: from config, "*")
  --force          Start even when NDOMO_HTTP_ENABLED is not "true"
  --help, -h       Show this help`);
      process.exit(0);
    }
  }

  return result;
}

/** Print startup banner. */
function printBanner(config: HttpConfig, dbPath: string): void {
  console.log(`
┌─────────────────────────────────────┐
│  ndomo HTTP server                  │
├─────────────────────────────────────┤
│  port:    ${String(config.port).padEnd(25)}│
│  auth:    ${(config.auth.required ? "enabled" : "disabled").padEnd(25)}│
│  cors:    ${config.cors.origins.join(", ").padEnd(25).slice(0, 25)}│
│  db:      ${dbPath.slice(-25).padEnd(25)}│
│  pid:     ${String(process.pid).padEnd(25)}│
└─────────────────────────────────────┘`);
}

/**
 * Load `.env` from cwd into process.env.
 * Shell environment wins — existing process.env keys are NOT overridden.
 * Returns the number of keys loaded.
 */
export function loadDotenv(cwd: string = process.cwd()): number {
  const envPath = join(cwd, ".env");
  if (!existsSync(envPath)) return 0;

  const content = readFileSync(envPath, "utf-8").replace(/^\uFEFF/, ""); // strip BOM
  let loaded = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const cleaned = line.startsWith("export ") ? line.slice(7) : line;
    const m = cleaned.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;

    const key = m[1]!;
    let value = m[2]!;
    // strip optional surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }

  if (loaded > 0) {
    console.log(`[env] loaded ${loaded} key(s) from .env`);
  }

  return loaded;
}

/** Main entry point. */
export async function runServe(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  // Load .env from cwd into process.env (shell env wins)
  loadDotenv();

  // Resolve DB
  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.error("error: .ndomo/state.db not found — run from project root or parent dir");
    process.exit(1);
  }

  // Open DB
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  // Load config + apply CLI overrides
  const config = loadHttpConfig();

  if (opts.port !== undefined) config.port = opts.port;
  if (opts.authRequired !== undefined) config.auth.required = opts.authRequired;
  if (opts.corsOrigins !== undefined) config.cors.origins = opts.corsOrigins;

  // Feature gate: require NDOMO_HTTP_ENABLED=true unless --force
  if (!config.enabled && !opts.force) {
    console.error(
      "error: HTTP server is disabled (NDOMO_HTTP_ENABLED is not 'true'). Use --force to override.",
    );
    db.close();
    process.exit(1);
  }

  printBanner(config, dbPath);

  // Start server
  let serverHandle: HttpServerHandle;
  try {
    serverHandle = await startHttpServer({ db, httpConfig: config });
  } catch (err) {
    console.error(
      `error: failed to start HTTP server: ${err instanceof Error ? err.message : String(err)}`,
    );
    db.close();
    process.exit(1);
  }

  console.log(`✓ HTTP server listening on port ${serverHandle.port}`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down...`);
    try {
      await serverHandle.stop();
      db.close();
      console.log("✓ Server stopped cleanly.");
      process.exit(0);
    } catch (err) {
      console.error(`error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
      db.close();
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Direct execution
if (import.meta.main) {
  runServe(process.argv.slice(2));
}
