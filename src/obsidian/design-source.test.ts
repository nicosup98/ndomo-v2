/**
 * Tests for the design source reader (`<projectDir>/.ndomo/designs/`).
 *
 * Covers: exact filename with/without `.md`, slug fallback over the
 * `YYYY-MM-DD-<slug>-design.md` shape of `design_create` (incl. collision
 * suffixes), missing dir/file → `null`, traversal input → `null` (a file that
 * actually exists OUTSIDE the designs dir is still never reached), directory
 * entries ignored, deterministic listing and verbatim content.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDesignFiles, readDesignSource } from "./design-source.ts";

const SOURCE_NAME = "2026-09-25-obsidian-brain-layer-design.md";
const SOURCE_BODY = "# Design: Obsidian Brain Layer\n\n## Problem\n\nNo human interface.\n";

let tmp: string;
let projectDir: string;
let designsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ndomo-obsidian-"));
  projectDir = join(tmp, "project");
  designsDir = join(projectDir, ".ndomo", "designs");
  mkdirSync(designsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeDesign(name: string, content: string): void {
  writeFileSync(join(designsDir, name), content, "utf-8");
}

describe("readDesignSource — exact filename", () => {
  test("resolves by full filename and returns content + project-relative sourcePath", () => {
    writeDesign(SOURCE_NAME, SOURCE_BODY);
    const result = readDesignSource(projectDir, SOURCE_NAME);
    expect(result).toEqual({
      filename: SOURCE_NAME,
      content: SOURCE_BODY,
      sourcePath: join(".ndomo", "designs", SOURCE_NAME),
    });
  });

  test("resolves by filename without the .md extension", () => {
    writeDesign(SOURCE_NAME, SOURCE_BODY);
    const result = readDesignSource(projectDir, "2026-09-25-obsidian-brain-layer-design");
    expect(result?.filename).toBe(SOURCE_NAME);
    expect(result?.content).toBe(SOURCE_BODY);
  });

  test("exact match wins over other slug candidates (deterministic)", () => {
    writeDesign(SOURCE_NAME, "primary");
    writeDesign("2026-01-01-obsidian-brain-layer-design.md", "decoy");
    const result = readDesignSource(projectDir, SOURCE_NAME);
    expect(result?.content).toBe("primary");
  });
});

describe("readDesignSource — slug fallback", () => {
  test("resolves a bare slug against the YYYY-MM-DD-<slug>-design.md shape", () => {
    writeDesign(SOURCE_NAME, SOURCE_BODY);
    const result = readDesignSource(projectDir, "obsidian-brain-layer");
    expect(result?.filename).toBe(SOURCE_NAME);
    expect(result?.content).toBe(SOURCE_BODY);
  });

  test("resolves `<slug>.md` and `*-<slug>.md` basenames", () => {
    writeDesign("plain-slug.md", "plain");
    writeDesign("2026-09-25-other-plain-slug.md", "suffixed");
    expect(readDesignSource(projectDir, "plain-slug")?.content).toBe("plain");
    expect(readDesignSource(projectDir, "other-plain-slug")?.content).toBe("suffixed");
  });

  test("resolves collision-suffixed files (`…-design-2.md`)", () => {
    writeDesign("2026-09-25-obsidian-brain-layer-design-2.md", "second");
    expect(readDesignSource(projectDir, "obsidian-brain-layer")?.content).toBe("second");
  });

  test("first match is deterministic for several candidates", () => {
    writeDesign("2026-01-01-multi-slug-design.md", "first");
    writeDesign("2026-02-01-multi-slug-design.md", "second");
    expect(readDesignSource(projectDir, "multi-slug")?.content).toBe("first");
  });

  test("a slug fragment bounded by hyphens also matches (documented rule)", () => {
    writeDesign(SOURCE_NAME, SOURCE_BODY);
    expect(readDesignSource(projectDir, "brain")?.filename).toBe(SOURCE_NAME);
    // Not hyphen-bounded in the filename → no match.
    expect(readDesignSource(projectDir, "layers")).toBeNull();
  });
});

describe("readDesignSource — not found / unsafe", () => {
  test("unknown filename and unknown slug resolve to null", () => {
    writeDesign(SOURCE_NAME, SOURCE_BODY);
    expect(readDesignSource(projectDir, "nope.md")).toBeNull();
    expect(readDesignSource(projectDir, "nope")).toBeNull();
    expect(readDesignSource(projectDir, "2026-09-25-other-design")).toBeNull();
  });

  test("empty / whitespace / dot inputs resolve to null", () => {
    writeDesign(SOURCE_NAME, SOURCE_BODY);
    expect(readDesignSource(projectDir, "")).toBeNull();
    expect(readDesignSource(projectDir, "   ")).toBeNull();
    expect(readDesignSource(projectDir, ".")).toBeNull();
    expect(readDesignSource(projectDir, "..")).toBeNull();
    expect(readDesignSource(projectDir, "./")).toBeNull();
  });

  test("a missing designs dir yields null (and lists nothing)", () => {
    const bare = join(tmp, "bare-project");
    mkdirSync(bare, { recursive: true });
    expect(readDesignSource(bare, SOURCE_NAME)).toBeNull();
    expect(listDesignFiles(bare)).toEqual([]);
  });

  test("traversal input never escapes the designs dir", () => {
    // A real file sits OUTSIDE the designs dir: reaching it would be a breach.
    const outside = join(tmp, "project", "etc");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "passwd"), "root:x:0:0", "utf-8");

    for (const attempt of [
      "../../../etc/passwd",
      "../../etc/passwd",
      "..\\..\\etc\\passwd",
      "etc/passwd",
    ]) {
      expect(readDesignSource(projectDir, attempt)).toBeNull();
    }
    // Traversal collapses to the basename, so it can only ever match INSIDE:
    // the returned content is the designs-dir file, never the outside one.
    writeDesign("passwd.md", "inside");
    expect(readDesignSource(projectDir, "../../../etc/passwd")?.content).toBe("inside");
    expect(readDesignSource(projectDir, "passwd")?.content).toBe("inside");
  });

  test("directory entries are never read as documents", () => {
    mkdirSync(join(designsDir, "folder.md"), { recursive: true });
    expect(readDesignSource(projectDir, "folder.md")).toBeNull();
    expect(listDesignFiles(projectDir)).toEqual([]);
  });
});

describe("listDesignFiles", () => {
  test("returns every .md filename sorted, ignoring non-markdown files", () => {
    writeDesign("2026-09-25-zeta-design.md", "z");
    writeDesign("2026-09-25-alpha-design.md", "a");
    writeFileSync(join(designsDir, "notes.txt"), "not markdown", "utf-8");
    expect(listDesignFiles(projectDir)).toEqual([
      "2026-09-25-alpha-design.md",
      "2026-09-25-zeta-design.md",
    ]);
  });
});
