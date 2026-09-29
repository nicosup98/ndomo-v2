/**
 * Tests for obsidian path builders + inside-repo guard (pure, tmp-dirs only).
 *
 * Covers: traversal-safe sanitization, slugify limits, vault root resolution +
 * creation, the lexical+realpath guard (INSIDE_REPO / UNSAFE_PATH / waiver),
 * folder-per-kind topology (8 kinds), note filename shapes (NN padding, id8
 * truncation, design basename, memory content slug) and POSIX relative paths.
 *
 * Also carries the small `types.ts` envelope assertions (types.ts has no
 * dedicated test file in this task's file list).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  checkVaultGuard,
  designNotePath,
  ensureVaultRoot,
  FOLDER_BY_KIND,
  isInsideRepo,
  MEMORIES_FOLDER,
  memoryNotePath,
  PLANS_FOLDER,
  planNotePath,
  projectRoot,
  resolveVaultRoot,
  sanitizeSegment,
  slugify,
  taskNotePath,
  toVaultRelative,
} from "./paths.ts";
import { isObsidianKind, type ObsidianKind, obsidianError } from "./types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ndomo-obsidian-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A sanitized segment must be a single, non-empty, traversal-free chunk. */
function expectSingleSegment(segment: string): void {
  expect(segment.length).toBeGreaterThan(0);
  expect(segment).not.toContain("/");
  expect(segment).not.toContain("\\");
  expect(segment).not.toContain("..");
  expect(segment.startsWith(".")).toBe(false);
}

describe("sanitizeSegment", () => {
  const traversalInputs = ["../../etc", "a/b", "..", "", "  ../  ", "..\\..\\windows", "/", "."];

  test("neutralizes every traversal input into a single in-namespace segment", () => {
    for (const input of traversalInputs) {
      expectSingleSegment(sanitizeSegment(input));
    }
  });

  test("traversal inputs stay inside the project namespace", () => {
    const vault = join(tmp, "vault");
    for (const input of traversalInputs) {
      const path = planNotePath(vault, input, input);
      expect(path.startsWith(join(vault, "Projects") + sep)).toBe(true);
      expect(path.slice(vault.length + 1).split(sep)).toHaveLength(4);
    }
  });

  test("kebab-cases: lowercases, collapses separators, strips accents", () => {
    expect(sanitizeSegment("  Hello   World  ")).toBe("hello-world");
    expect(sanitizeSegment("Diseño Final")).toBe("diseno-final");
    expect(sanitizeSegment("ndomo_project_abc123")).toBe("ndomo-project-abc123");
    expect(sanitizeSegment("a---b")).toBe("a-b");
  });

  test("falls back to untitled when nothing survives", () => {
    expect(sanitizeSegment("")).toBe("untitled");
    expect(sanitizeSegment("../")).toBe("untitled");
    expect(sanitizeSegment("....")).toBe("untitled");
  });
});

describe("slugify", () => {
  test("caps at 6 words by default", () => {
    expect(slugify("one two three four five six seven")).toBe("one-two-three-four-five-six");
  });

  test("honors an explicit maxWords", () => {
    expect(slugify("one two three four", 3)).toBe("one-two-three");
  });

  test("traversal content cannot escape the filename", () => {
    const slug = slugify("../../etc/passwd rm -rf /", 6);
    expectSingleSegment(slug);
    expect(slug).not.toContain(" ");
  });

  test("empty input falls back to untitled", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("   ")).toBe("untitled");
  });
});

describe("resolveVaultRoot / ensureVaultRoot", () => {
  test("expands ~ to the user home and returns an absolute path", () => {
    expect(resolveVaultRoot({ vaultPath: "~/vault-x" })).toBe(join(homedir(), "vault-x"));
  });

  test("resolves relative paths to absolute", () => {
    const root = resolveVaultRoot({ vaultPath: "rel-vault" });
    expect(root).toBe(resolve(join(process.cwd(), "rel-vault")));
  });

  test("rejects an empty vaultPath with an internal TypeError", () => {
    expect(() => resolveVaultRoot({ vaultPath: "" })).toThrow(TypeError);
    expect(() => resolveVaultRoot({ vaultPath: "   " })).toThrow(TypeError);
  });

  test("ensureVaultRoot creates the dir recursively once", () => {
    const vaultPath = join(tmp, "nested", "vault");
    const first = ensureVaultRoot({ vaultPath });
    expect(first.root).toBe(vaultPath);
    expect(first.created).toBe(true);
    expect(ensureVaultRoot({ vaultPath }).created).toBe(false);
  });

  test("resolveVaultRoot stays pure (no dir created)", () => {
    const vaultPath = join(tmp, "pure-vault");
    resolveVaultRoot({ vaultPath });
    expect(ensureVaultRoot({ vaultPath }).created).toBe(true);
  });
});

describe("inside-repo guard", () => {
  function makeRepo(): string {
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    return repo;
  }

  test("vault inside the repo is rejected", () => {
    const repo = makeRepo();
    expect(isInsideRepo(join(repo, "vault"), repo)).toBe(true);
    const result = checkVaultGuard(join(repo, "vault"), repo, false);
    expect(result).toEqual({
      ok: false,
      code: "INSIDE_REPO",
      message: expect.stringContaining("inside the project repo"),
    });
  });

  test("vault equal to the repo itself is inside", () => {
    const repo = makeRepo();
    expect(checkVaultGuard(repo, repo, false).ok).toBe(false);
  });

  test("allowInsideRepo=true waives the guard (config-only)", () => {
    const repo = makeRepo();
    expect(checkVaultGuard(join(repo, "vault"), repo, true)).toEqual({ ok: true });
  });

  test("vault outside the repo passes", () => {
    const repo = makeRepo();
    const vault = join(tmp, "outside-vault");
    mkdirSync(vault, { recursive: true });
    expect(isInsideRepo(vault, repo)).toBe(false);
    expect(checkVaultGuard(vault, repo, false)).toEqual({ ok: true });
  });

  test("sibling directories are not inside", () => {
    const repo = makeRepo();
    expect(isInsideRepo(join(tmp, "repo-other"), repo)).toBe(false);
  });

  test("relative vaultPath is UNSAFE_PATH (checked before the repo guard)", () => {
    const repo = makeRepo();
    const result = checkVaultGuard("relative/vault", repo, true);
    expect(result).toEqual({ ok: false, code: "UNSAFE_PATH", message: expect.any(String) });
  });

  test("realpath catches a symlink pointing into the repo", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "vault"), { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(repo, link);
    expect(isInsideRepo(join(link, "vault"), repo)).toBe(true);
    expect(checkVaultGuard(join(link, "vault"), repo, false).ok).toBe(false);
  });

  test("missing vault (no realpath yet) falls back to lexical", () => {
    const repo = makeRepo();
    expect(isInsideRepo(join(tmp, "brand-new-vault"), repo)).toBe(false);
  });
});

describe("namespace + note builders", () => {
  const vault = "/srv/vault";
  const tag = "my-project";

  test("projectRoot namespaces under Projects/<tag>", () => {
    expect(projectRoot(vault, tag)).toBe(join(vault, "Projects", "my-project"));
    expect(projectRoot(vault, "../../etc")).toBe(join(vault, "Projects", "etc"));
  });

  test("plan notes land in 10-Plans", () => {
    expect(planNotePath(vault, tag, "Ship the thing")).toBe(
      join(vault, "Projects", tag, PLANS_FOLDER, "ship-the-thing.md"),
    );
    expect(planNotePath(vault, tag, "../evil")).toBe(
      join(vault, "Projects", tag, PLANS_FOLDER, "evil.md"),
    );
  });

  const kindFolders: Array<[ObsidianKind, string]> = [
    ["feature", "20-Features"],
    ["bugfix", "30-Bugfixes"],
    ["infra", "40-Infra"],
    ["design", "50-Designs"],
    ["docs", "70-Docs"],
    ["refactor", "60-Refactors"],
    ["research", "80-Research"],
    ["other", "90-Other"],
  ];

  test("maps all 8 kinds to their folder", () => {
    expect(Object.keys(FOLDER_BY_KIND)).toHaveLength(kindFolders.length);
    for (const [kind, folder] of kindFolders) {
      expect(FOLDER_BY_KIND[kind]).toBe(folder);
      const path = taskNotePath(
        vault,
        tag,
        kind,
        "plan-a",
        1,
        "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      );
      expect(path).toBe(join(vault, "Projects", tag, folder, "plan-a__t01-a1b2c3d4.md"));
    }
  });

  test("task order index is zero-padded (NN)", () => {
    const cases: Array<[number, string]> = [
      [0, "t00"],
      [1, "t01"],
      [9, "t09"],
      [10, "t10"],
      [42, "t42"],
      [123, "t123"],
      [7.9, "t07"],
    ];
    for (const [orderIndex, fragment] of cases) {
      const path = taskNotePath(
        vault,
        tag,
        "feature",
        "plan-a",
        orderIndex,
        "deadbeef-0000-0000-0000-000000000000",
      );
      expect(basename(path)).toBe(`plan-a__${fragment}-deadbeef.md`);
    }
  });

  test("task id is truncated to 8 sanitized chars", () => {
    const upper = taskNotePath(
      vault,
      tag,
      "bugfix",
      "plan-a",
      2,
      "ABCDEF12-3456-7890-abcd-ef0123456789",
    );
    expect(basename(upper)).toBe("plan-a__t02-abcdef12.md");
    const traversal = taskNotePath(vault, tag, "bugfix", "plan-a", 2, "../../../etc");
    expectSingleSegment(basename(traversal));
    expect(traversal).toContain("__t02-");
  });

  test("design notes keep the source filename in 50-Designs", () => {
    expect(designNotePath(vault, tag, "2026-09-25-obsidian-brain-layer-design.md")).toBe(
      join(vault, "Projects", tag, "50-Designs", "2026-09-25-obsidian-brain-layer-design.md"),
    );
    expect(designNotePath(vault, tag, "../../evil.md")).toBe(
      join(vault, "Projects", tag, "50-Designs", "evil.md"),
    );
    expect(designNotePath(vault, tag, "no-extension")).toBe(
      join(vault, "Projects", tag, "50-Designs", "no-extension.md"),
    );
  });

  test("memory notes use a 6-word content slug + id8 in 95-Memories", () => {
    const path = memoryNotePath(
      vault,
      tag,
      "the quick brown fox jumps over the lazy dog today",
      "01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(path).toBe(
      join(vault, "Projects", tag, MEMORIES_FOLDER, "the-quick-brown-fox-jumps-over__01234567.md"),
    );
    const traversal = memoryNotePath(vault, tag, "../../etc", "..");
    expect(traversal.startsWith(join(vault, "Projects", tag, MEMORIES_FOLDER) + sep)).toBe(true);
  });

  test("toVaultRelative returns a POSIX relative path", () => {
    const abs = join(vault, "Projects", tag, PLANS_FOLDER, "plan-a.md");
    expect(toVaultRelative(vault, abs)).toBe(`Projects/${tag}/10-Plans/plan-a.md`);
    expect(toVaultRelative(vault, abs)).not.toContain("\\");
    expect(toVaultRelative(vault, abs).startsWith("/")).toBe(false);
  });
});

describe("types.ts envelope", () => {
  test("obsidianError omits hint when absent (exactOptionalPropertyTypes)", () => {
    const bare = obsidianError("DISABLED", "obsidian is disabled");
    expect(bare.ok).toBe(false);
    expect("hint" in bare.error).toBe(false);

    const hinted = obsidianError("NOT_CONFIGURED", "vaultPath missing", "set obsidian.vaultPath");
    expect(hinted.error.hint).toBe("set obsidian.vaultPath");
  });

  test("isObsidianKind guards the override vocabulary", () => {
    expect(isObsidianKind("feature")).toBe(true);
    expect(isObsidianKind("question")).toBe(false);
    expect(isObsidianKind(42)).toBe(false);
  });
});
