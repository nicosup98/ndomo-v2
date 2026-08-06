/**
 * Tests for src/cli/task.ts — CLI task CRUD subcommands.
 *
 * Uses bun:test with a tmp dir `.ndomo/state.db` (chdir pattern, same as
 * status.test.ts and plan.test.ts).
 *
 * Coverage:
 * 1. task create with valid args
 * 2. task create with empty agent → throws
 * 3. task list --plan <id>
 * 4. task show <id>
 * 5. task update --status running
 * 6. task update with bogus status → throws
 * 7. task reassign
 * 8. task complete
 * 9. task fail --error
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../db/migrations.ts";
import { runPlan } from "../plan.ts";
import { runTask } from "../task.ts";

let tmpDir: string;
let origCwd: string;

function captureOutput(fn: () => void): { stdout: string; stderr: string; exitCode: number | null } {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  console.log = (...args: unknown[]) => {
    stdout += args.map(String).join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    stderr += args.map(String).join(" ") + "\n";
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__process_exit__");
  }) as typeof process.exit;

  try {
    fn();
  } catch (err) {
    if (!(err instanceof Error && err.message === "__process_exit__")) {
      throw err;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { stdout, stderr, exitCode };
}

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-task-test-"));
  const ndomoDir = join(tmpDir, ".ndomo");
  mkdirSync(ndomoDir, { recursive: true });
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(join(ndomoDir, "state.db"));
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  db.close();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
});

/** Helper to create a parent plan + return its id. */
function createPlanViaCli(slug: string): string {
  const { stdout } = captureOutput(() => {
    runPlan(["create", "--slug", slug, "--title", "T", "--overview", "O"]);
  });
  return JSON.parse(stdout).id as string;
}

describe("task create", () => {
  test("creates a task with valid args", () => {
    const planId = createPlanViaCli("task-create-plan");

    const { stdout, exitCode } = captureOutput(() => {
      runTask(["create", "--plan", planId, "--agent", "craft", "--description", "do thing"]);
    });
    expect(exitCode).toBeNull();
    const task = JSON.parse(stdout);
    expect(task.planId).toBe(planId);
    expect(task.agent).toBe("craft");
    expect(task.description).toBe("do thing");
    expect(task.status).toBe("pending");
  });

  test("rejects empty agent", () => {
    const planId = createPlanViaCli("task-empty-agent");

    const { exitCode, stderr } = captureOutput(() => {
      runTask(["create", "--plan", planId, "--agent", "", "--description", "d"]);
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/agent/i);
  });
});

describe("task list", () => {
  test("returns tasks for plan", () => {
    const planId = createPlanViaCli("task-list-plan");

    captureOutput(() => {
      runTask(["create", "--plan", planId, "--agent", "craft", "--description", "d1"]);
    });
    captureOutput(() => {
      runTask(["create", "--plan", planId, "--agent", "craft", "--description", "d2"]);
    });

    const { stdout, exitCode } = captureOutput(() => {
      runTask(["list", "--plan", planId, "--json"]);
    });
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });
});

describe("task show", () => {
  test("shows task by id", () => {
    const planId = createPlanViaCli("task-show-plan");

    const created = JSON.parse(
      captureOutput(() => {
        runTask(["create", "--plan", planId, "--agent", "craft", "--description", "shown"]);
      }).stdout,
    );

    const { stdout, exitCode } = captureOutput(() => {
      runTask(["show", created.id]);
    });
    expect(exitCode).toBeNull();
    const task = JSON.parse(stdout);
    expect(task.id).toBe(created.id);
    expect(task.description).toBe("shown");
  });
});

describe("task update", () => {
  test("updates status to running", () => {
    const planId = createPlanViaCli("task-update-plan");
    const created = JSON.parse(
      captureOutput(() => {
        runTask(["create", "--plan", planId, "--agent", "craft", "--description", "d"]);
      }).stdout,
    );

    captureOutput(() => {
      runTask(["update", created.id, "--status", "running"]);
    });

    const shown = JSON.parse(
      captureOutput(() => {
        runTask(["show", created.id]);
      }).stdout,
    );
    expect(shown.status).toBe("running");
  });

  test("rejects bogus status", () => {
    const planId = createPlanViaCli("task-bogus-status");
    const created = JSON.parse(
      captureOutput(() => {
        runTask(["create", "--plan", planId, "--agent", "craft", "--description", "d"]);
      }).stdout,
    );

    const { exitCode, stderr } = captureOutput(() => {
      runTask(["update", created.id, "--status", "bogus"]);
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/status/i);
  });
});

describe("task reassign", () => {
  test("reassigns task to new agent", () => {
    const planId = createPlanViaCli("task-reassign-plan");
    const created = JSON.parse(
      captureOutput(() => {
        runTask(["create", "--plan", planId, "--agent", "craft", "--description", "d"]);
      }).stdout,
    );

    captureOutput(() => {
      runTask(["reassign", created.id, "--agent", "newagent"]);
    });

    const shown = JSON.parse(
      captureOutput(() => {
        runTask(["show", created.id]);
      }).stdout,
    );
    expect(shown.agent).toBe("newagent");
  });
});

describe("task complete", () => {
  test("completes a task", () => {
    const planId = createPlanViaCli("task-complete-plan");
    const created = JSON.parse(
      captureOutput(() => {
        runTask(["create", "--plan", planId, "--agent", "craft", "--description", "d"]);
      }).stdout,
    );

    captureOutput(() => {
      runTask(["complete", created.id, "--result", "Done!"]);
    });

    const shown = JSON.parse(
      captureOutput(() => {
        runTask(["show", created.id]);
      }).stdout,
    );
    expect(shown.status).toBe("done");
    expect(shown.result).toBe("Done!");
  });
});

describe("task fail", () => {
  test("fails a task with error", () => {
    const planId = createPlanViaCli("task-fail-plan");
    const created = JSON.parse(
      captureOutput(() => {
        runTask(["create", "--plan", planId, "--agent", "craft", "--description", "d"]);
      }).stdout,
    );

    captureOutput(() => {
      runTask(["fail", created.id, "--error", "Something went wrong"]);
    });

    const shown = JSON.parse(
      captureOutput(() => {
        runTask(["show", created.id]);
      }).stdout,
    );
    expect(shown.status).toBe("failed");
    expect(shown.error).toBe("Something went wrong");
  });
});