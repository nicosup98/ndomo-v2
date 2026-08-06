/**
 * Tests for src/cli/plan.ts — CLI plan CRUD subcommands.
 *
 * Uses bun:test with a tmp dir `.ndomo/state.db` (chdir pattern, same as
 * status.test.ts). Tests the runPlan function by passing parsed args.
 *
 * Coverage:
 * 1. plan create --slug <slug> --title <title> --overview <text>
 * 2. plan create --slug INVALID SLUG (slug regex)
 * 3. plan create --owner invalid_owner (owner enum)
 * 4. plan list
 * 5. plan list --status draft
 * 6. plan show <id>
 * 7. plan show <slug>
 * 8. plan update <id> --title New
 * 9. plan update <id> --owner craftsman
 * 10. plan update <id> --owner bogus
 * 11. plan approve <id>
 * 12. plan complete <id>
 * 13. plan delete <id>
 * 14. plan assign-task <planId> --agent craft --description d
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../db/migrations.ts";
import { runPlan } from "../plan.ts";

let tmpDir: string;
let origCwd: string;

/** Capture console output and stub process.exit so we can assert on stdout. */
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
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-plan-test-"));
  const ndomoDir = join(tmpDir, ".ndomo");
  mkdirSync(ndomoDir, { recursive: true });
  // Bootstrap DB with migrations using a throwaway connection (then close so CLI can reopen).
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

describe("plan create", () => {
  test("creates a plan with valid args", () => {
    const { stdout, exitCode } = captureOutput(() => {
      runPlan(["create", "--slug", "my-plan", "--title", "My Plan", "--overview", "Plan overview"]);
    });
    expect(exitCode).toBeNull();
    const plan = JSON.parse(stdout);
    expect(plan.slug).toBe("my-plan");
    expect(plan.title).toBe("My Plan");
    expect(plan.overview).toBe("Plan overview");
    expect(plan.status).toBe("draft");
    expect(plan.owner).toBe("foreman"); // default
    expect(plan.complexity).toBe(2); // default per validateComplexity
  });

  test("rejects invalid slug", () => {
    const { exitCode, stderr } = captureOutput(() => {
      runPlan(["create", "--slug", "INVALID SLUG", "--title", "T", "--overview", "O"]);
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/slug/i);
  });

  test("rejects invalid owner", () => {
    const { exitCode, stderr } = captureOutput(() => {
      runPlan([
        "create",
        "--slug",
        "ok-slug",
        "--title",
        "T",
        "--overview",
        "O",
        "--owner",
        "bogus",
      ]);
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/owner/i);
  });

  test("accepts valid owner override", () => {
    const { stdout, exitCode } = captureOutput(() => {
      runPlan([
        "create",
        "--slug",
        "owner-test",
        "--title",
        "T",
        "--overview",
        "O",
        "--owner",
        "craftsman",
      ]);
    });
    expect(exitCode).toBeNull();
    const plan = JSON.parse(stdout);
    expect(plan.owner).toBe("craftsman");
  });
});

describe("plan list", () => {
  test("returns empty list when no plans exist", () => {
    const { stdout, exitCode } = captureOutput(() => {
      runPlan(["list", "--json"]);
    });
    expect(exitCode).toBeNull();
    // --json returns empty array literal
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(0);
  });

  test("lists all plans", () => {
    captureOutput(() => {
      runPlan(["create", "--slug", "p1", "--title", "P1", "--overview", "O1"]);
    });
    captureOutput(() => {
      runPlan(["create", "--slug", "p2", "--title", "P2", "--overview", "O2"]);
    });

    const { stdout, exitCode } = captureOutput(() => {
      runPlan(["list", "--json"]);
    });
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    const slugs = parsed.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain("p1");
    expect(slugs).toContain("p2");
  });

  test("filters by status", () => {
    captureOutput(() => {
      runPlan(["create", "--slug", "draft1", "--title", "D", "--overview", "O"]);
    });
    const { stdout, exitCode } = captureOutput(() => {
      runPlan(["list", "--status", "draft", "--json"]);
    });
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((p: { status: string }) => p.status === "draft")).toBe(true);
    const slugs = parsed.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain("draft1");
  });
});

describe("plan show", () => {
  test("shows plan by id", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "show-id", "--title", "T", "--overview", "O"]);
      }).stdout,
    );

    const { stdout, exitCode } = captureOutput(() => {
      runPlan(["show", created.id]);
    });
    expect(exitCode).toBeNull();
    const plan = JSON.parse(stdout);
    expect(plan.id).toBe(created.id);
    expect(plan.slug).toBe("show-id");
  });

  test("shows plan by slug", () => {
    captureOutput(() => {
      runPlan(["create", "--slug", "show-slug", "--title", "T", "--overview", "O"]);
    });

    const { stdout, exitCode } = captureOutput(() => {
      runPlan(["show", "show-slug"]);
    });
    expect(exitCode).toBeNull();
    const plan = JSON.parse(stdout);
    expect(plan.slug).toBe("show-slug");
  });
});

describe("plan update", () => {
  test("updates title", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "upd", "--title", "Old", "--overview", "O"]);
      }).stdout,
    );

    const { exitCode } = captureOutput(() => {
      runPlan(["update", created.id, "--title", "New"]);
    });
    expect(exitCode).toBeNull();

    const shown = JSON.parse(
      captureOutput(() => {
        runPlan(["show", created.id]);
      }).stdout,
    );
    expect(shown.title).toBe("New");
  });

  test("updates owner", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "owner-up", "--title", "T", "--overview", "O"]);
      }).stdout,
    );

    captureOutput(() => {
      runPlan(["update", created.id, "--owner", "craftsman"]);
    });

    const shown = JSON.parse(
      captureOutput(() => {
        runPlan(["show", created.id]);
      }).stdout,
    );
    expect(shown.owner).toBe("craftsman");
  });

  test("rejects invalid owner on update", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "owner-up2", "--title", "T", "--overview", "O"]);
      }).stdout,
    );

    const { exitCode, stderr } = captureOutput(() => {
      runPlan(["update", created.id, "--owner", "bogus"]);
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/owner/i);
  });
});

describe("plan approve", () => {
  test("sets status to approved", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "approve-me", "--title", "T", "--overview", "O"]);
      }).stdout,
    );

    captureOutput(() => {
      runPlan(["approve", created.id]);
    });

    const shown = JSON.parse(
      captureOutput(() => {
        runPlan(["show", created.id]);
      }).stdout,
    );
    expect(shown.status).toBe("approved");
  });
});

describe("plan complete", () => {
  test("sets status to completed", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "complete-me", "--title", "T", "--overview", "O"]);
      }).stdout,
    );

    captureOutput(() => {
      runPlan(["complete", created.id]);
    });

    const shown = JSON.parse(
      captureOutput(() => {
        runPlan(["show", created.id]);
      }).stdout,
    );
    expect(shown.status).toBe("completed");
  });
});

describe("plan delete", () => {
  test("rejects deletion of draft plans (must be approved first)", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "del-me", "--title", "T", "--overview", "O"]);
      }).stdout,
    );

    const { exitCode, stderr } = captureOutput(() => {
      runPlan(["delete", created.id]);
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/draft/i);
  });

  test("archives the plan after approval", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "del-ok", "--title", "T", "--overview", "O"]);
      }).stdout,
    );

    captureOutput(() => {
      runPlan(["approve", created.id]);
    });

    const { exitCode, stdout } = captureOutput(() => {
      runPlan(["delete", created.id]);
    });
    expect(exitCode).toBeNull();
    // deletePlan returns DeletePlanResult JSON — confirm tasksDeleted field exists
    expect(stdout).toMatch(/"tasksDeleted"/);
  });
});

describe("plan assign-task", () => {
  test("creates a task on the plan", () => {
    const created = JSON.parse(
      captureOutput(() => {
        runPlan(["create", "--slug", "with-task", "--title", "T", "--overview", "O"]);
      }).stdout,
    );

    const { stdout, exitCode } = captureOutput(() => {
      runPlan(["assign-task", created.id, "--agent", "craft", "--description", "do thing"]);
    });
    expect(exitCode).toBeNull();
    const task = JSON.parse(stdout);
    expect(task.planId).toBe(created.id);
    expect(task.agent).toBe("craft");
    expect(task.description).toBe("do thing");
    expect(task.status).toBe("pending");
  });
});