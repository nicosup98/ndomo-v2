#!/usr/bin/env bun
/**
 * One-shot CLI migration from opencode-mem shards into the ndomo embedded
 * memory store.
 *
 * Usage:
 *   bun scripts/migrate-memory.ts [--dry-run] [--source <dir>] [--target <dir>]
 *
 * Defaults:
 *   source = ~/.opencode-mem/data/projects
 *   target = ~/.ndomo/mem
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { migrateMemories } from "../src/mem/migrate.ts";

type Args = {
  dryRun: boolean;
  source: string;
  target: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    source: join(homedir(), ".opencode-mem", "data", "projects"),
    target: join(homedir(), ".ndomo", "mem"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--source") {
      const value = argv[i + 1];
      if (value) {
        args.source = value;
        i += 1;
      }
    } else if (arg === "--target") {
      const value = argv[i + 1];
      if (value) {
        args.target = value;
        i += 1;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const report = migrateMemories({
  source: args.source,
  target: args.target,
  dryRun: args.dryRun,
  log: (msg) => console.error(msg),
});

console.log(JSON.stringify(report, null, 2));
process.exit(report.errors.length > 0 ? 1 : 0);
