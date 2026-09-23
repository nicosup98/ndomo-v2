/**
 * Tests for ndomo memory tag identity (src/mem/tags.ts).
 *
 * Replicates the verified opencode-mem algorithm with the `ndomo` prefix.
 * Includes fixed hash vectors for this machine/repo (hard asserts, per the
 * design doc) plus dynamic vectors for throwaway git / non-git directories.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { getProjectTagInfo, getTags, getUserTagInfo } from "./tags.ts";

function sha16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ndomo-mem-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("getProjectTagInfo — fixed vectors", () => {
  test("this repo resolves to the verified ndomo project tag", () => {
    expect(getProjectTagInfo("/home/tecnologia/ndomo-v2").tag).toBe(
      "ndomo_project_3630017a493b9b23",
    );
  });
});

describe("getUserTagInfo — fixed vector", () => {
  test("git user.email resolves to the verified ndomo user tag", () => {
    expect(getUserTagInfo().tag).toBe("ndomo_user_b3f8b37e159f9b98");
  });
});

describe("getProjectTagInfo — dynamic vectors", () => {
  test("git repo uses git-common identity", () => {
    const dir = makeTmpDir();
    execSync("git init -q", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    const commonDir = realpathSync(join(dir, ".git"));
    const expected = `ndomo_project_${sha16(`git-common:${commonDir}`)}`;
    expect(getProjectTagInfo(dir).tag).toBe(expected);
  });

  test("non-git dir uses normalized path identity", () => {
    const dir = makeTmpDir();
    const expected = `ndomo_project_${sha16(`path:${normalize(dir)}`)}`;
    expect(getProjectTagInfo(dir).tag).toBe(expected);
  });

  test("subdir of a git repo shares the root project tag", () => {
    const dir = makeTmpDir();
    execSync("git init -q", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(getProjectTagInfo(sub).tag).toBe(getProjectTagInfo(dir).tag);
  });
});

describe("getTags", () => {
  test("returns both user and project tags non-empty", () => {
    const dir = makeTmpDir();
    const tags = getTags(dir);
    expect(tags.user.tag.startsWith("ndomo_user_")).toBe(true);
    expect(tags.project.tag.startsWith("ndomo_project_")).toBe(true);
    expect(tags.user.tag.length).toBeGreaterThan("ndomo_user_".length);
    expect(tags.project.tag.length).toBeGreaterThan("ndomo_project_".length);
  });
});
