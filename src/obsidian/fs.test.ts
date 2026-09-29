/**
 * Tests for obsidian fs helpers (atomic write + sha256 + tolerant reads).
 *
 * Covers: deterministic hashing, atomic overwrite semantics (complete content,
 * no orphan `*.tmp`), temp cleanup when the rename target is invalid, and the
 * missing-file contracts of read/delete.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFileSync,
  deleteFileIfExists,
  ensureDir,
  readFileIfExists,
  sha256Hex,
} from "./fs.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ndomo-obsidian-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tempLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((entry) => entry.endsWith(".tmp"));
}

describe("sha256Hex", () => {
  test("matches the known digest of the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("is deterministic: same input → same 64-char hex", () => {
    const a = sha256Hex("ndomo:plan:abc");
    const b = sha256Hex("ndomo:plan:abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different inputs → different digests", () => {
    expect(sha256Hex("ndomo:plan:abc")).not.toBe(sha256Hex("ndomo:plan:abd"));
  });
});

describe("atomicWriteFileSync", () => {
  test("creates missing parent directories", () => {
    const file = join(tmp, "a", "b", "note.md");
    atomicWriteFileSync(file, "hello");
    expect(readFileSync(file, "utf-8")).toBe("hello");
  });

  test("overwrites with complete content and leaves no *.tmp", () => {
    const file = join(tmp, "note.md");
    const big = "x".repeat(200_000);
    atomicWriteFileSync(file, big);
    expect(readFileSync(file, "utf-8")).toBe(big);

    atomicWriteFileSync(file, "short");
    expect(readFileSync(file, "utf-8")).toBe("short");

    atomicWriteFileSync(file, big);
    expect(readFileSync(file, "utf-8")).toBe(big);

    expect(tempLeftovers(tmp)).toHaveLength(0);
  });

  test("cleans the temp file when the rename target is invalid", () => {
    const file = join(tmp, "blocked");
    mkdirSync(file, { recursive: true });
    expect(() => atomicWriteFileSync(file, "content")).toThrow();
    expect(tempLeftovers(tmp)).toHaveLength(0);
  });
});

describe("readFileIfExists / deleteFileIfExists / ensureDir", () => {
  test("reads existing content and reports missing files as null", () => {
    const file = join(tmp, "note.md");
    expect(readFileIfExists(file)).toBeNull();
    atomicWriteFileSync(file, "payload");
    expect(readFileIfExists(file)).toBe("payload");
  });

  test("deleteFileIfExists reports whether it removed something", () => {
    const file = join(tmp, "note.md");
    expect(deleteFileIfExists(file)).toBe(false);
    atomicWriteFileSync(file, "payload");
    expect(deleteFileIfExists(file)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(deleteFileIfExists(file)).toBe(false);
  });

  test("ensureDir is idempotent and recursive", () => {
    const dir = join(tmp, "deep", "nested");
    ensureDir(dir);
    ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
  });
});
