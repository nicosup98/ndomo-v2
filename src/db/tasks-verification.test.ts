/**
 * T1 (v17) execution gates — behavioral tests.
 *
 * Covers:
 *  - createTasksBatch with verificationRequired=true / metadata opt-in
 *  - gated task cannot transition to 'done' without verification
 *  - inspector can pass; non-inspector cannot pass without force
 *  - 'failed'/'waived' verdicts require reason
 *  - override of an existing 'passed' requires force
 *  - force bypass on updateTaskStatus('done') records audit trail + waives
 *  - default (legacy) tasks remain un-gated — backward compatibility
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { createPlan } from "./plans.ts";
import {
  createTasksBatch,
  getTask,
  recordTaskVerification,
  updateTaskStatus,
} from "./tasks.ts";
import type { Plan } from "./types.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

function makePlan(): Plan {
  return createPlan(db, {
    id: crypto.randomUUID(),
    slug: `plan-${crypto.randomUUID().slice(0, 8)}`,
    title: "T",
    status: "draft",
    priority: 2,
    approvedAt: null,
    completedAt: null,
    sessionId: null,
    overview: "test",
    approach: null,
    complexity: 3,
    createdBy: "test",
    updatedBy: "test",
    sourceSessionId: null,
    sourceMessageId: null,
    category: null,
    owner: "foreman",
    metadata: {},
    archivedAt: null,
  });
}

function baseTaskInput() {
  return {
    description: "gated task",
    agent: "js-smith",
    files: [] as string[],
    complexity: 1,
    dependencies: [] as string[],
    createdBy: "foreman",
    updatedBy: "foreman",
    sourceSessionId: null,
    sourceMessageId: null,
    reviewedBy: null,
    tokensUsed: null,
    durationMs: null,
    artifacts: [] as string[],
    metadata: {},
  };
}

// ─── createTasksBatch: verificationRequired opt-in ───────────────────────────

describe("createTasksBatch — verificationRequired opt-in (T1)", () => {
  test("explicit verificationRequired=true marks task as pending verification", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    expect(tasks[0]!.verificationRequired).toBe(true);
    expect(tasks[0]!.verificationStatus).toBe("pending");
    expect(tasks[0]!.verificationResult).toBeNull();
    expect(tasks[0]!.verificationPassedAt).toBeNull();
    expect(tasks[0]!.verifiedBy).toBeNull();
  });

  test("omitting verificationRequired defaults to false / 'not_required' (legacy)", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [baseTaskInput()]);
    expect(tasks[0]!.verificationRequired).toBe(false);
    expect(tasks[0]!.verificationStatus).toBe("not_required");
  });

  test("metadata.verificationRequired=true is honored as backwards-compatible opt-in", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), metadata: { verificationRequired: true } },
    ]);
    expect(tasks[0]!.verificationRequired).toBe(true);
    expect(tasks[0]!.verificationStatus).toBe("pending");
  });

  test("mixed batch: gated + un-gated tasks coexist", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), description: "gated", verificationRequired: true },
      { ...baseTaskInput(), description: "free", verificationRequired: false },
    ]);
    const gated = tasks.find((t) => t.description === "gated");
    const free = tasks.find((t) => t.description === "free");
    expect(gated!.verificationRequired).toBe(true);
    expect(gated!.verificationStatus).toBe("pending");
    expect(free!.verificationRequired).toBe(false);
    expect(free!.verificationStatus).toBe("not_required");
  });
});

// ─── Gate: updateTaskStatus('done') ─────────────────────────────────────────

describe("updateTaskStatus — execution gate (T1)", () => {
  test("gated task CANNOT transition to 'done' without verification", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    // Move to running first (closer to real flow).
    updateTaskStatus(db, task!.id, "running", undefined, "js-smith", {
      agent: "js-smith",
    });
    expect(() =>
      updateTaskStatus(db, task!.id, "done", undefined, "js-smith"),
    ).toThrowError(/requires verification/);
    // Status stayed running.
    const still = getTask(db, task!.id);
    expect(still!.status).toBe("running");
    expect(still!.verificationStatus).toBe("pending");
  });

  test("gated task CAN transition to 'failed' without verification (failure is not a reward)", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    expect(() =>
      updateTaskStatus(db, task!.id, "failed", { error: "boom" }, "js-smith"),
    ).not.toThrow();
    const failed = getTask(db, task!.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.verificationStatus).toBe("pending");
  });

  test("after inspector passes, gated task CAN transition to 'done'", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    recordTaskVerification(db, task!.id, "passed", { checks: ["lint", "types"] }, "inspector");
    expect(() =>
      updateTaskStatus(db, task!.id, "done", { result: "shipped" }, "js-smith"),
    ).not.toThrow();
    const done = getTask(db, task!.id);
    expect(done!.status).toBe("done");
    expect(done!.verificationStatus).toBe("passed");
  });

  test("force bypass waives the gate and records audit trail in metadata", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    updateTaskStatus(
      db,
      task!.id,
      "done",
      { force: true, forceReason: "hotfix — inspector unavailable, rollback needed", result: "ok" },
      "foreman",
    );
    const done = getTask(db, task!.id);
    expect(done!.status).toBe("done");
    expect(done!.verificationStatus).toBe("waived");
    expect(done!.metadata.verificationBypass).toBeDefined();
    expect(done!.metadata.verificationBypass).toMatchObject({
      forceReason: "hotfix — inspector unavailable, rollback needed",
      forcedBy: "foreman",
    });
    expect(typeof done!.metadata.verificationBypass!.forcedAt).toBe("number");
  });

  test("force WITHOUT forceReason is rejected (forceReason must be non-blank)", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    expect(() =>
      updateTaskStatus(db, task!.id, "done", { force: true }, "foreman"),
    ).toThrowError(/requires verification/);
    expect(() =>
      updateTaskStatus(db, task!.id, "done", { force: true, forceReason: "   " }, "foreman"),
    ).toThrowError(/requires verification/);
  });

  test("already-waived task CAN be re-done without re-forcing", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    updateTaskStatus(
      db,
      task!.id,
      "done",
      { force: true, forceReason: "first waive" },
      "foreman",
    );
    // Re-open as running, then done again — gate is now open (waived).
    updateTaskStatus(db, task!.id, "running", undefined, "js-smith");
    expect(() =>
      updateTaskStatus(db, task!.id, "done", { result: "ok" }, "js-smith"),
    ).not.toThrow();
  });

  test("LEGACY (un-gated) task goes done normally — backward compatibility", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [baseTaskInput()]);
    expect(() =>
      updateTaskStatus(db, task!.id, "done", { result: "ok" }, "js-smith"),
    ).not.toThrow();
    const done = getTask(db, task!.id);
    expect(done!.status).toBe("done");
    expect(done!.verificationStatus).toBe("not_required");
  });
});

// ─── recordTaskVerification — authority rules ───────────────────────────────

describe("recordTaskVerification — authority rules (T1)", () => {
  test("inspector CAN pass a gated task", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    const result = recordTaskVerification(
      db,
      task!.id,
      "passed",
      { coverage: 0.92 },
      "inspector",
    );
    expect(result.verificationStatus).toBe("passed");
    expect(result.verificationResult).toEqual({ coverage: 0.92 });
    expect(result.verificationPassedAt).toBeTypeOf("number");
    expect(result.verifiedBy).toBe("inspector");
  });

  test("non-inspector CANNOT pass without force", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    expect(() =>
      recordTaskVerification(db, task!.id, "passed", undefined, "craftsman"),
    ).toThrowError(/only 'inspector' may record verdict='passed'/);
    // State unchanged.
    const still = getTask(db, task!.id);
    expect(still!.verificationStatus).toBe("pending");
    expect(still!.verificationPassedAt).toBeNull();
  });

  test("non-inspector CAN pass with force + forceReason", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    const result = recordTaskVerification(db, task!.id, "passed", undefined, "foreman", {
      force: true,
      forceReason: "inspector offline — foreman vouches via CI green",
    });
    expect(result.verificationStatus).toBe("passed");
    expect(result.verificationPassedAt).toBeTypeOf("number");
  });

  test("'failed' verdict requires non-blank reason (silent rejection forbidden)", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    expect(() =>
      recordTaskVerification(db, task!.id, "failed", undefined, "inspector"),
    ).toThrowError(/requires a non-blank reason/);
    const ok = recordTaskVerification(db, task!.id, "failed", undefined, "inspector", {
      reason: "lint errors in 3 files",
    });
    expect(ok.verificationStatus).toBe("failed");
    expect(ok.verificationPassedAt).toBeNull();
    expect(ok.verifiedBy).toBe("inspector");
  });

  test("'waived' verdict requires non-blank reason", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    expect(() =>
      recordTaskVerification(db, task!.id, "waived", undefined, "foreman"),
    ).toThrowError(/requires a non-blank reason/);
    const ok = recordTaskVerification(db, task!.id, "waived", undefined, "foreman", {
      reason: "out of scope — will be reworked in next plan",
    });
    expect(ok.verificationStatus).toBe("waived");
  });

  test("invalid verdict throws", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    expect(() =>
      // @ts-expect-error — intentionally invalid verdict
      recordTaskVerification(db, task!.id, "approved", undefined, "inspector"),
    ).toThrowError(/invalid verification verdict/);
  });

  test("task not found throws", () => {
    expect(() =>
      recordTaskVerification(db, "missing-id", "passed", undefined, "inspector"),
    ).toThrowError(/task not found/);
  });

  test("overriding an existing 'passed' requires force (positive verdict is immutable-ish)", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    recordTaskVerification(db, task!.id, "passed", undefined, "inspector");
    expect(() =>
      recordTaskVerification(db, task!.id, "failed", undefined, "inspector", {
        reason: "regression found later",
      }),
    ).toThrowError(/already has verification_status='passed'/);
    // With force it works.
    const overridden = recordTaskVerification(db, task!.id, "failed", undefined, "inspector", {
      reason: "regression found later",
      force: true,
      forceReason: "post-merge incident — revoke previous pass",
    });
    expect(overridden.verificationStatus).toBe("failed");
    expect(overridden.verificationPassedAt).toBeNull();
  });

  // ── resolveVerificationActor branch coverage (Issue 2 regression) ──

  test("forced 'passed' with NO explicit verifiedBy stamps verified_by='forced' (deterministic actor)", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    const result = recordTaskVerification(db, task!.id, "passed", undefined, undefined, {
      force: true,
      forceReason: "inspector unreachable — CI green vouches for the change",
    });
    expect(result.verificationStatus).toBe("passed");
    expect(result.verifiedBy).toBe("forced");
    expect(result.verificationPassedAt).toBeTypeOf("number");
  });

  test("explicit verifiedBy always wins over the 'forced' fallback", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    const result = recordTaskVerification(db, task!.id, "passed", undefined, "foreman", {
      force: true,
      forceReason: "foreman vouches",
    });
    expect(result.verifiedBy).toBe("foreman");
  });

  test("unforced verdict with no verifiedBy leaves verified_by=null (unattributed)", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    const result = recordTaskVerification(db, task!.id, "failed", undefined, undefined, {
      reason: "lint failed",
    });
    expect(result.verificationStatus).toBe("failed");
    expect(result.verifiedBy).toBeNull();
  });

  // ── Rule 4b: non-inspector 'failed' restricted to pending tasks ──
  // Regression: a non-authoritative caller may only record a negative verdict
  // while the task is still pending; once in-flight, the inspector owns it.

  test("non-inspector 'failed' is REJECTED once the task has left 'pending'", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    // Move the task into running — it is no longer pending.
    updateTaskStatus(db, task!.id, "running", undefined, "js-smith", { agent: "js-smith" });
    expect(() =>
      recordTaskVerification(db, task!.id, "failed", undefined, "craftsman", {
        reason: "looks broken mid-flight",
      }),
    ).toThrowError(/only accepted while the task is pending/);
    // State unchanged — verification columns untouched.
    const still = getTask(db, task!.id);
    expect(still!.status).toBe("running");
    expect(still!.verificationStatus).toBe("pending");
    expect(still!.verifiedBy).toBeNull();
  });

  test("non-inspector 'failed' IS accepted while the task is still pending (early rejection)", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    // Task is freshly created → status='pending'. Non-inspector may fail now.
    const result = recordTaskVerification(db, task!.id, "failed", undefined, "craftsman", {
      reason: "blocked by upstream design issue before starting",
    });
    expect(result.verificationStatus).toBe("failed");
    expect(result.verifiedBy).toBe("craftsman");
  });

  test("inspector 'failed' is accepted on a non-pending (running) task — authority is unrestricted", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    updateTaskStatus(db, task!.id, "running", undefined, "js-smith", { agent: "js-smith" });
    const result = recordTaskVerification(db, task!.id, "failed", undefined, "inspector", {
      reason: "regression detected in CI mid-execution",
    });
    expect(result.verificationStatus).toBe("failed");
    expect(result.verifiedBy).toBe("inspector");
  });
});

// ─── updateTaskStatus — caller-input immutability (Issue 1 regression) ──────

describe("updateTaskStatus — caller-input immutability (T1)", () => {
  test("force bypass does NOT mutate the caller's fields.metadataPatch", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    const callerPatch = { priority: "hotfix", notes: "pre-bypass" };
    const fields = {
      force: true,
      forceReason: "inspector offline",
      metadataPatch: callerPatch,
    };
    const patchSnapshot = JSON.parse(JSON.stringify(fields.metadataPatch));

    updateTaskStatus(db, task!.id, "done", fields, "foreman");

    // The caller's object must be byte-for-byte unchanged.
    expect(fields.metadataPatch).toEqual(patchSnapshot);
    expect(fields.metadataPatch).not.toHaveProperty("verificationBypass");
    // Nested reference untouched too.
    expect(callerPatch).toEqual({ priority: "hotfix", notes: "pre-bypass" });

    // Persisted task DOES carry both the caller patch and the bypass audit.
    const done = getTask(db, task!.id);
    expect(done!.status).toBe("done");
    expect(done!.verificationStatus).toBe("waived");
    // Caller patch keys land in metadata JSON (deep-merged); TaskMetadata is
    // a typed subset, so cast for arbitrary-key assertions.
    expect((done!.metadata as Record<string, unknown>).priority).toBe("hotfix");
    expect(done!.metadata.verificationBypass).toMatchObject({
      forceReason: "inspector offline",
      forcedBy: "foreman",
    });
  });

  test("force bypass with NO metadataPatch still records the audit trail and leaves fields untouched", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    const fields = { force: true, forceReason: "no patch supplied" };

    updateTaskStatus(db, task!.id, "done", fields, "foreman");

    expect(fields).toEqual({ force: true, forceReason: "no patch supplied" });
    const done = getTask(db, task!.id);
    expect(done!.metadata.verificationBypass).toMatchObject({
      forcedBy: "foreman",
      forceReason: "no patch supplied",
    });
  });

  // ── System audit wins over caller-supplied verificationBypass ──
  // Regression: the merge order must put bypassAudit LAST so a caller cannot
  // forge the forcedBy/forceReason/forcedAt audit record via metadataPatch.
  test("caller-supplied metadataPatch.verificationBypass is OVERWRITTEN by the system audit (system wins)", () => {
    const plan = makePlan();
    const [task] = createTasksBatch(db, plan.id, [
      { ...baseTaskInput(), verificationRequired: true },
    ]);
    updateTaskStatus(
      db,
      task!.id,
      "done",
      {
        force: true,
        forceReason: "real reason — inspector offline",
        metadataPatch: {
          verificationBypass: {
            forcedBy: "malicious-caller",
            forceReason: "forged reason",
            forcedAt: 0,
          },
          note: "legit caller key",
        },
      },
      "foreman",
    );
    const done = getTask(db, task!.id);
    expect(done!.status).toBe("done");
    expect(done!.verificationStatus).toBe("waived");
    // System audit wins — forcedBy/forceReason reflect the ACTUAL caller + reason.
    expect(done!.metadata.verificationBypass).toMatchObject({
      forcedBy: "foreman",
      forceReason: "real reason — inspector offline",
    });
    expect(done!.metadata.verificationBypass!.forcedBy).not.toBe("malicious-caller");
    expect(done!.metadata.verificationBypass!.forceReason).not.toBe("forged reason");
    expect(typeof done!.metadata.verificationBypass!.forcedAt).toBe("number");
    expect(done!.metadata.verificationBypass!.forcedAt).not.toBe(0);
    // The caller's other (non-forged) keys still land normally.
    expect((done!.metadata as Record<string, unknown>).note).toBe("legit caller key");
  });
});
