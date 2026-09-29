/**
 * Tests for the obsidian sync-state store (tolerant load + atomic save).
 *
 * Every call passes an explicit tmp `homeDir` — the real `~` is never touched.
 *
 * Covers: path layout, missing → fresh + warning, garbage / bad-shape / bad-
 * entry → fresh-or-partial + corrupt warning, save→load roundtrip, hash
 * comparison and the createdAt/updatedAt/lastCheckedAt upsert invariants.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { atomicWriteFileSync } from "./fs.ts";
import {
  freshSyncState,
  hashEquals,
  loadSyncState,
  saveSyncState,
  syncEntryKey,
  syncStatePath,
  upsertEntry,
} from "./sync-state.ts";
import type { ObsidianSyncState } from "./types.ts";

const TAG = "ndomo_project_test0000000000";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ndomo-obsidian-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("syncStatePath", () => {
  test("lives under <home>/.ndomo/obsidian/projects/<tag>/sync-state.json", () => {
    const path = syncStatePath(TAG, home);
    expect(path.startsWith(join(home, ".ndomo", "obsidian", "projects") + sep)).toBe(true);
    expect(path.endsWith(join("sync-state.json"))).toBe(true);
  });

  test("defaults to the real home (path computation only)", () => {
    expect(syncStatePath(TAG).startsWith(homedir() + sep)).toBe(true);
  });

  test("traversal tags cannot escape the sync-state namespace", () => {
    const path = syncStatePath("../../evil", home);
    expect(path.startsWith(join(home, ".ndomo", "obsidian", "projects") + sep)).toBe(true);
    expect(path).not.toContain("..");
  });
});

describe("loadSyncState", () => {
  test("missing file → fresh state + missing warning", () => {
    const { state, warning } = loadSyncState(TAG, home);
    expect(state).toEqual({ version: 1, projectTag: TAG, entries: {} });
    expect(warning).toBe("sync-state missing");
  });

  test("garbage content → fresh state + corrupt warning (never throws)", () => {
    atomicWriteFileSync(syncStatePath(TAG, home), "not-json{ at all");
    const { state, warning } = loadSyncState(TAG, home);
    expect(state.entries).toEqual({});
    expect(state.projectTag).toBe(TAG);
    expect(warning).toBe("sync-state corrupt");
  });

  test("valid JSON with a bad top-level shape → fresh + corrupt", () => {
    atomicWriteFileSync(syncStatePath(TAG, home), JSON.stringify({ version: 2, entries: {} }));
    expect(loadSyncState(TAG, home).warning).toBe("sync-state corrupt");

    atomicWriteFileSync(syncStatePath(TAG, home), JSON.stringify({ version: 1, entries: [] }));
    expect(loadSyncState(TAG, home).warning).toBe("sync-state corrupt");

    atomicWriteFileSync(syncStatePath(TAG, home), JSON.stringify("string"));
    expect(loadSyncState(TAG, home).warning).toBe("sync-state corrupt");
  });

  test("invalid entries are dropped, valid ones survive", () => {
    atomicWriteFileSync(
      syncStatePath(TAG, home),
      JSON.stringify({
        version: 1,
        projectTag: TAG,
        entries: {
          "plan:p1": {
            path: "Projects/tag/10-Plans/p1.md",
            kind: "feature",
            hash: "abc",
            createdAt: 1,
            updatedAt: 2,
            lastCheckedAt: 3,
          },
          "plan:broken": { path: "", kind: "nope", hash: "", createdAt: "x" },
          "no-colon": {
            path: "x.md",
            kind: "docs",
            hash: "h",
            createdAt: 1,
            updatedAt: 1,
            lastCheckedAt: 1,
          },
        },
      }),
    );
    const { state, warning } = loadSyncState(TAG, home);
    expect(warning).toBe("sync-state corrupt");
    expect(Object.keys(state.entries)).toEqual(["plan:p1"]);
  });
});

describe("saveSyncState / roundtrip", () => {
  function seed(now = 1_700_000_000_000): ObsidianSyncState {
    const state = freshSyncState(TAG);
    upsertEntry(
      state,
      "plan",
      "p1",
      { path: "Projects/tag/10-Plans/p1.md", kind: "feature", hash: "h1", createdAt: now - 5 },
      now,
    );
    upsertEntry(
      state,
      "memory",
      "m1",
      { path: "Projects/tag/95-Memories/hello__01234567.md", kind: "other", hash: "h2" },
      now,
    );
    return state;
  }

  test("save → load roundtrips entries and clears the warning", () => {
    const state = seed();
    saveSyncState(TAG, state, home);

    const loaded = loadSyncState(TAG, home);
    expect(loaded.warning).toBeNull();
    expect(loaded.state).toEqual(state);
    expect(syncEntryKey("plan", "p1") in loaded.state.entries).toBe(true);
  });

  test("save writes only inside the given home dir", () => {
    saveSyncState(TAG, seed(), home);
    expect(syncStatePath(TAG, home).startsWith(home + sep)).toBe(true);
    expect(loadSyncState(TAG, home).warning).toBeNull();
  });

  test("upsert preserves createdAt and only bumps updatedAt when the hash changes", () => {
    const state = freshSyncState(TAG);
    const t0 = 1_700_000_000_000;
    const patch = { path: "Projects/tag/10-Plans/p1.md", kind: "bugfix" as const, hash: "h1" };

    upsertEntry(state, "plan", "p1", { ...patch, createdAt: t0 - 60_000 }, t0);
    expect(state.entries["plan:p1"]).toEqual({
      path: patch.path,
      kind: "bugfix",
      hash: "h1",
      createdAt: t0 - 60_000,
      updatedAt: t0,
      lastCheckedAt: t0,
    });

    // Same hash → only lastCheckedAt moves.
    upsertEntry(state, "plan", "p1", patch, t0 + 1_000);
    expect(state.entries["plan:p1"]?.updatedAt).toBe(t0);
    expect(state.entries["plan:p1"]?.lastCheckedAt).toBe(t0 + 1_000);
    expect(state.entries["plan:p1"]?.createdAt).toBe(t0 - 60_000);

    // New hash → updatedAt advances too, createdAt still preserved.
    upsertEntry(state, "plan", "p1", { ...patch, hash: "h2" }, t0 + 2_000);
    expect(state.entries["plan:p1"]?.hash).toBe("h2");
    expect(state.entries["plan:p1"]?.updatedAt).toBe(t0 + 2_000);
    expect(state.entries["plan:p1"]?.createdAt).toBe(t0 - 60_000);
  });
});

describe("hashEquals", () => {
  const state = freshSyncState(TAG);

  test("false for unknown entities, true only on exact hash match", () => {
    expect(hashEquals(state, "design", "d1", "h")).toBe(false);
    upsertEntry(state, "design", "d1", { path: "p.md", kind: "design", hash: "h1" }, 1);
    expect(hashEquals(state, "design", "d1", "h1")).toBe(true);
    expect(hashEquals(state, "design", "d1", "h2")).toBe(false);
  });
});
