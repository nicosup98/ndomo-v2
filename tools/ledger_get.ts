/**
 * ndomo — ledger_get custom tool (filesystem continuity ledger).
 *
 * DB-FREE read of a portable session ledger file at
 * `<projectDir>/.ndomo/ledgers/{sessionId}.md`. Mirrors the DB-free
 * design_create tool pattern: only resolveProjectDir + the core ledger
 * API (no openDb / runMigrations).
 *
 * Two read modes:
 *   - parsed (default): returns the machine-readable {@link LedgerData}
 *     struct extracted from the embedded JSON block, or `null` if the
 *     ledger is missing / corrupt (matches the getSession / getPlan
 *     "not found → null" convention).
 *   - raw: returns the human-readable markdown verbatim (string), or
 *     `null` if the file is missing. Useful when the caller wants the
 *     full prose doc rather than the parsed struct.
 *
 * sessionId is validated + sanitized for the filename inside readLedger
 * / readLedgerRaw (path-traversal-safe), so an attacker-controlled id
 * like `../../etc/passwd` is neutralized regardless of caller care.
 */

import { tool } from "@opencode-ai/plugin";
import { readLedger, readLedgerRaw, resolveProjectDir } from "ndomo/db";

export default tool({
  description:
    "Read a portable session ledger from <projectDir>/.ndomo/ledgers/{sessionId}.md. DB-free. Returns the parsed ledger data, or null if the ledger does not exist. Pass raw=true to return the full human-readable markdown instead (still null when the file is missing). sessionId is sanitized for the filename (path-traversal-safe).",
  args: {
    sessionId: tool.schema.string(),
    raw: tool.schema.boolean().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    if (args.raw) {
      return JSON.stringify(readLedgerRaw(projectDir, args.sessionId));
    }
    return JSON.stringify(readLedger(projectDir, args.sessionId));
  },
});
