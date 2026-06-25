import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("frontmatter newline preservation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `fm-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    mkdirSync(join(tmp, "agent"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("closing --- stays on its own line after install", async () => {
    const src = join(process.cwd(), "agents/foreman.md");
    const dst = join(tmp, "agent/foreman.md");
    const original = readFileSync(src, "utf-8");
    writeFileSync(dst, original);

    process.env.XDG_CONFIG_HOME = tmp;
    const { spawnSync } = await import("bun");
    const r = spawnSync({
      cmd: ["bun", "run", "src/cli/install.ts", "--preset=default", "--no-provider-prompt"],
      env: { ...process.env, XDG_CONFIG_HOME: tmp },
      cwd: process.cwd(),
    });
    expect(r.exitCode).toBe(0);

    const after = readFileSync(dst, "utf-8");
    // Closing --- must be on its own line (count of lines starting with --- alone should be 2: open + close)
    const matches = after.match(/^---$/gm) || [];
    expect(matches.length).toBe(2);
    // Frontmatter body must not end with `allow---` (glued)
    expect(after).not.toMatch(/allow---/);
    // Permission nesting must be preserved
    expect(after).toMatch(/permission:\n\s+edit:/);
  });
});
