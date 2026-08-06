/**
 * ndomo — ledger_update custom tool (filesystem continuity ledger).
 *
 * DB-FREE partial update of a portable session ledger at
 * `<projectDir>/.ndomo/ledgers/{sessionId}.md`. Reads the existing
 * ledger, shallow-merges the provided patch fields, and rewrites it
 * atomically via the core {@link writeLedger}.
 *
 * Semantics (deliberately distinct from ledger_create):
 *   - REQUIRES an existing ledger. If none exists, throws a descriptive
 *     error pointing the caller at ledger_create. This avoids a silent
 *     upsert that would paper over a missing-prerequisite bug.
 *   - PATCH, not replace: only fields explicitly provided are changed.
 *     Omitted fields preserve their existing values. A field explicitly
 *     passed as `null` (e.g. keyDecisions) IS written as null — that is a
 *     meaningful "clear this" intent, distinct from "leave it alone".
 *   - IMMUTABLE bookkeeping preserved: sessionId and startedAt are never
 *     modified by update (they are identity / origin metadata). Pass them
 *     via ledger_create instead.
 *
 * state / metadata are REPLACED wholesale when provided (not deep-merged),
 * mirroring checkpointSession semantics — deep-merging would risk
 * leaving stale keys. Callers wanting a merged state should read first,
 * merge client-side, and pass the full new state.
 *
 * The rewrite is atomic + idempotent (inherited from writeLedger), and
 * sessionId is sanitized for the filename (path-traversal-safe).
 */

import { tool } from "@opencode-ai/plugin";
import type { LedgerData } from "ndomo/db";
import { readLedger, resolveProjectDir, writeLedger } from "ndomo/db";

export default tool({
  description:
    "Patch an existing portable session ledger at <projectDir>/.ndomo/ledgers/{sessionId}.md. DB-free, atomic, read-merge-rewrite. Throws if the ledger does not exist (use ledger_create first). All fields optional: goal, planId, state, keyDecisions, agentHistory, metadata, lastCheckpoint, endedAt, outcome. Only provided fields change; an explicit null clears a field. sessionId and startedAt are immutable here. state/metadata are replaced wholesale (not deep-merged). sessionId is sanitized for the filename (path-traversal-safe).",
  args: {
    sessionId: tool.schema.string(),
    goal: tool.schema.string().optional(),
    // Nullable-optional: these fields carry `| null` in {@link LedgerData}, so
    // an explicit null is a meaningful "clear this" intent (distinct from
    // omission = preserve). The merge below keys off `!== undefined`, so once
    // the schema admits null the omitted-vs-clear distinction is honored.
    planId: tool.schema.string().nullable().optional(),
    state: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
    keyDecisions: tool.schema.string().nullable().optional(),
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
    lastCheckpoint: tool.schema.number().nullable().optional(),
    endedAt: tool.schema.number().nullable().optional(),
    outcome: tool.schema.enum(["success", "partial", "failed", "abandoned"]).nullable().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);

    const existing = readLedger(projectDir, args.sessionId);
    if (existing === null) {
      throw new Error(
        `ndomo: cannot update ledger — no ledger found for sessionId '${args.sessionId}' at <projectDir>/.ndomo/ledgers/. Use ledger_create first.`,
      );
    }

    // Normalize an incoming agent-history patch to the full Session shape
    // (matches ledger_create normalization). Keeps "omitted" vs "explicit
    // null" distinct: undefined entry fields fall back to null/now, but a
    // caller-supplied null stays null.
    const agentHistoryPatch =
      args.agentHistory !== undefined
        ? args.agentHistory.map((h) => ({
            agent: h.agent,
            taskId: h.taskId ?? null,
            startedAt: h.startedAt ?? Date.now(),
            endedAt: h.endedAt ?? null,
          }))
        : undefined;

    // Shallow-merge: only provided fields override. Constructed with the
    // conditional-spread idiom so "omitted" vs "explicitly null" stay
    // distinct (null is a meaningful clear, undefined = preserve).
    const merged: LedgerData = {
      ...existing,
      ...(args.goal !== undefined && { goal: args.goal }),
      ...(args.planId !== undefined && { planId: args.planId }),
      ...(args.state !== undefined && { state: args.state }),
      ...(args.keyDecisions !== undefined && { keyDecisions: args.keyDecisions }),
      ...(agentHistoryPatch !== undefined && { agentHistory: agentHistoryPatch }),
      ...(args.metadata !== undefined && { metadata: args.metadata }),
      ...(args.lastCheckpoint !== undefined && { lastCheckpoint: args.lastCheckpoint }),
      ...(args.endedAt !== undefined && { endedAt: args.endedAt }),
      ...(args.outcome !== undefined && { outcome: args.outcome }),
      // sessionId + startedAt intentionally NOT overridable here.
    };

    const result = writeLedger(projectDir, merged);
    return JSON.stringify(result, null, 2);
  },
});
