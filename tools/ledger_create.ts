/**
 * ndomo — ledger_create custom tool (filesystem continuity ledger).
 *
 * DB-FREE write of a portable session ledger to
 * `<projectDir>/.ndomo/ledgers/{sessionId}.md`. Mirrors the design_create
 * tool pattern: resolveProjectDir + core ledger API only (no DB).
 *
 * Assembles a {@link LedgerData} snapshot from flat tool args and persists
 * it via the core {@link writeLedger}, which is:
 *   - ATOMIC (temp-file + rename) — a crash never leaves a partial file.
 *   - IDEMPOTENT — same input → byte-identical output modulo updatedAt.
 *   - PATH-SAFE — sessionId is sanitized (path-traversal-neutralized).
 *
 * The returned {@link LedgerWriteResult} carries a `created` flag so the
 * caller can tell a genuine first-write (`created: true`) from an
 * overwrite of an existing ledger (`created: false`). This keeps
 * create-vs-update honest without a separate code path: re-creating an
 * existing ledger simply refreshes it (idempotent overwrite) and reports
 * `created: false`. For a read-merge-patch flow use ledger_update instead.
 *
 * Bookkeeping fields not provided by the caller are defaulted sensibly:
 * startedAt = now, lastCheckpoint = null, endedAt = null, outcome = null.
 * Each agentHistory entry is normalized (taskId/endedAt → null when
 * omitted, startedAt → now when omitted) so callers can pass a minimal
 * `{ agent }` list.
 */

import { tool } from "@opencode-ai/plugin";
import type { LedgerData } from "ndomo/db";
import { resolveProjectDir, writeLedger } from "ndomo/db";

export default tool({
  description:
    "Create (or idempotently overwrite) a portable session ledger at <projectDir>/.ndomo/ledgers/{sessionId}.md. DB-free, atomic write. Required: sessionId, goal. Optional: planId, state, keyDecisions, agentHistory, metadata, startedAt. Returns { sessionId, filePath, byteSize, updatedAt, created } where created=true means the file did not exist before. sessionId is sanitized for the filename (path-traversal-safe). To patch an existing ledger without rewriting it whole, use ledger_update.",
  args: {
    sessionId: tool.schema.string(),
    goal: tool.schema.string(),
    planId: tool.schema.string().optional(),
    state: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
    keyDecisions: tool.schema.string().optional(),
    agentHistory: tool.schema
      .array(
        tool.schema.object({
          agent: tool.schema.string(),
          taskId: tool.schema.string().optional(),
          startedAt: tool.schema.number().optional(),
          endedAt: tool.schema.number().optional(),
        }),
      )
      .optional(),
    metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
    startedAt: tool.schema.number().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const now = Date.now();

    // Normalize each agent-history entry to the full Session shape.
    const agentHistory = (args.agentHistory ?? []).map((h) => ({
      agent: h.agent,
      taskId: h.taskId ?? null,
      startedAt: h.startedAt ?? now,
      endedAt: h.endedAt ?? null,
    }));

    const data: LedgerData = {
      sessionId: args.sessionId,
      goal: args.goal,
      planId: args.planId ?? null,
      state: args.state ?? {},
      keyDecisions: args.keyDecisions ?? null,
      agentHistory,
      startedAt: args.startedAt ?? now,
      // Bookkeeping defaults for a freshly-created ledger. These are not
      // meaningful until a checkpoint/end actually happens — callers that
      // need them set should use ledger_update after the fact.
      lastCheckpoint: null,
      endedAt: null,
      outcome: null,
      metadata: args.metadata ?? {},
    };

    const result = writeLedger(projectDir, data);
    return JSON.stringify(result, null, 2);
  },
});
