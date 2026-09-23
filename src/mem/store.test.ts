/**
 * Tests for the ndomo embedded memory store (src/mem/store.ts).
 *
 * Each test gets a fresh on-disk DB under a tmp dir (bun:sqlite needs a real
 * file for WAL + FK pragmas). Storage root is per-test isolated.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMemSchema } from "./schema.ts";
import {
  addMemory,
  deleteMemory,
  expandHome,
  getMemory,
  listMemories,
  listProjectDbs,
  openMemDb,
  statsMemories,
  updateMemory,
} from "./store.ts";

const PROJECT_TAG = "ndomo_project_test0000000000";

const identity = {
  projectTag: PROJECT_TAG,
  projectPath: "/tmp/proj",
  projectName: "proj",
  gitRepoUrl: "https://example.com/proj.git",
  userName: "foreman",
  userEmail: "foreman@ndomo.local",
};

let storagePath: string;
let db: Database;

beforeEach(() => {
  storagePath = mkdtempSync(join(tmpdir(), "ndomo-mem-"));
  db = openMemDb(PROJECT_TAG, storagePath);
});

afterEach(() => {
  db.close();
  rmSync(storagePath, { recursive: true, force: true });
});

describe("openMemDb / ensureMemSchema", () => {
  test("ensureMemSchema is idempotent and records version 1", () => {
    expect(() => ensureMemSchema(db)).not.toThrow();
    expect(() => ensureMemSchema(db)).not.toThrow();
    const row = db.query("SELECT version FROM schema_version").get() as { version: number };
    expect(row.version).toBe(1);
  });
});

describe("addMemory / getMemory", () => {
  test("roundtrip persists all fields and hydrates tags/metadata", () => {
    const { memory, deduplicated } = addMemory(db, {
      content: "hello world",
      type: "note",
      tags: ["alpha", "beta"],
      pinned: true,
      metadata: { source: "test", n: 1 },
      source: "manual",
      identity,
    });

    expect(deduplicated).toBe(false);
    expect(memory.id.length).toBeGreaterThan(0);
    expect(memory.content).toBe("hello world");
    expect(memory.type).toBe("note");
    expect(memory.tags).toEqual(["alpha", "beta"]);
    expect(memory.projectTag).toBe(PROJECT_TAG);
    expect(memory.projectPath).toBe("/tmp/proj");
    expect(memory.projectName).toBe("proj");
    expect(memory.gitRepoUrl).toBe("https://example.com/proj.git");
    expect(memory.userName).toBe("foreman");
    expect(memory.userEmail).toBe("foreman@ndomo.local");
    expect(memory.contentHash.length).toBe(64);
    expect(memory.isPinned).toBe(true);
    expect(memory.source).toBe("manual");
    expect(memory.metadata).toEqual({ source: "test", n: 1 });

    const fetched = getMemory(db, memory.id);
    expect(fetched).toEqual(memory);
  });

  test("applies defaults: type=note, source=manual, metadata=null, unpinned, no tags", () => {
    const { memory } = addMemory(db, { content: "defaults", identity });
    expect(memory.type).toBe("note");
    expect(memory.source).toBe("manual");
    expect(memory.metadata).toBeNull();
    expect(memory.isPinned).toBe(false);
    expect(memory.tags).toEqual([]);
  });

  test("getMemory returns null for unknown id", () => {
    expect(getMemory(db, "nope")).toBeNull();
  });
});

describe("addMemory dedup", () => {
  test("same trimmed content returns existing row and does not insert", () => {
    const first = addMemory(db, { content: "  x  ", identity });
    expect(first.deduplicated).toBe(false);

    const second = addMemory(db, { content: "x", identity });
    expect(second.deduplicated).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(statsMemories(db).total).toBe(1);
  });
});

describe("listMemories", () => {
  test("filters by type, tag and pinned", () => {
    addMemory(db, { content: "a", type: "note", tags: ["t1"], identity });
    addMemory(db, { content: "b", type: "decision", tags: ["t2"], pinned: true, identity });
    addMemory(db, { content: "c", type: "note", tags: ["t1", "t2"], identity });

    const byType = listMemories(db, { type: "note" });
    expect(byType.total).toBe(2);
    expect(byType.memories.map((m) => m.content).sort()).toEqual(["a", "c"]);

    const byTag = listMemories(db, { tag: "t2" });
    expect(byTag.total).toBe(2);
    expect(byTag.memories.map((m) => m.content).sort()).toEqual(["b", "c"]);

    const pinned = listMemories(db, { pinned: true });
    expect(pinned.total).toBe(1);
    expect(pinned.memories[0]?.content).toBe("b");

    const unpinned = listMemories(db, { pinned: false });
    expect(unpinned.total).toBe(2);
  });

  test("orders pinned first, then created_at DESC", () => {
    const a = addMemory(db, { content: "a", identity });
    const b = addMemory(db, { content: "b", identity });
    const c = addMemory(db, { content: "c", identity });
    // Deterministic timestamps + pinned flag (Date.now() collides within a ms).
    db.query("UPDATE memories SET created_at = 100 WHERE id = ?").run(a.memory.id);
    db.query("UPDATE memories SET created_at = 300 WHERE id = ?").run(b.memory.id);
    db.query("UPDATE memories SET created_at = 200, is_pinned = 1 WHERE id = ?").run(c.memory.id);

    const { memories } = listMemories(db);
    expect(memories.map((m) => m.id)).toEqual([c.memory.id, b.memory.id, a.memory.id]);
  });

  test("paginates with limit/offset while total ignores pagination", () => {
    for (let i = 0; i < 5; i++) {
      addMemory(db, { content: `m${i}`, identity });
    }
    const page = listMemories(db, { limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.memories).toHaveLength(2);
  });
});

describe("updateMemory", () => {
  test("recomputes contentHash and updatedAt on content change", async () => {
    const { memory } = addMemory(db, { content: "old", identity });
    await Bun.sleep(2);

    const updated = updateMemory(db, memory.id, { content: "new content" });
    expect(updated?.content).toBe("new content");
    expect(updated?.contentHash).not.toBe(memory.contentHash);
    expect(updated?.updatedAt).toBeGreaterThan(memory.updatedAt);
  });

  test("replaces tags wholesale", () => {
    const { memory } = addMemory(db, { content: "tagged", tags: ["a", "b"], identity });
    const updated = updateMemory(db, memory.id, { tags: ["c"] });
    expect(updated?.tags).toEqual(["c"]);
  });

  test("updates type and pinned", () => {
    const { memory } = addMemory(db, { content: "flags", identity });
    const updated = updateMemory(db, memory.id, { type: "decision", pinned: true });
    expect(updated?.type).toBe("decision");
    expect(updated?.isPinned).toBe(true);
  });

  test("returns null for unknown id", () => {
    expect(updateMemory(db, "missing", { content: "x" })).toBeNull();
  });

  test("throws on content hash collision with another memory", () => {
    addMemory(db, { content: "unique one", identity });
    const second = addMemory(db, { content: "unique two", identity });
    expect(() => updateMemory(db, second.memory.id, { content: "unique one" })).toThrow(
      /content hash collision/,
    );
  });
});

describe("deleteMemory", () => {
  test("deletes row and cascades tags", () => {
    const { memory } = addMemory(db, { content: "doomed", tags: ["x", "y"], identity });

    expect(deleteMemory(db, memory.id)).toBe(true);
    expect(getMemory(db, memory.id)).toBeNull();

    const row = db
      .query("SELECT COUNT(*) AS c FROM memory_tags WHERE memory_id = ?")
      .get(memory.id) as { c: number };
    expect(row.c).toBe(0);
  });

  test("returns false for unknown id", () => {
    expect(deleteMemory(db, "missing")).toBe(false);
  });
});

describe("statsMemories", () => {
  test("aggregates totals, types, tags, pinned and range", () => {
    const a = addMemory(db, { content: "a", type: "note", tags: ["t1"], identity });
    const b = addMemory(db, {
      content: "b",
      type: "decision",
      tags: ["t1", "t2"],
      pinned: true,
      identity,
    });
    db.query("UPDATE memories SET created_at = 100 WHERE id = ?").run(a.memory.id);
    db.query("UPDATE memories SET created_at = 500 WHERE id = ?").run(b.memory.id);

    const stats = statsMemories(db);
    expect(stats.total).toBe(2);
    expect(stats.byType).toEqual({ note: 1, decision: 1 });
    expect(stats.byTag).toEqual({ t1: 2, t2: 1 });
    expect(stats.pinned).toBe(1);
    expect(stats.oldest).toBe(100);
    expect(stats.newest).toBe(500);
  });

  test("empty db has zeroed stats", () => {
    const stats = statsMemories(db);
    expect(stats.total).toBe(0);
    expect(stats.byType).toEqual({});
    expect(stats.byTag).toEqual({});
    expect(stats.pinned).toBe(0);
    expect(stats.oldest).toBeNull();
    expect(stats.newest).toBeNull();
  });
});

describe("per-project isolation and listProjectDbs", () => {
  test("separate tags have separate memories; listProjectDbs finds both", () => {
    const otherTag = "ndomo_project_other000000000";
    const otherDb = openMemDb(otherTag, storagePath);
    try {
      addMemory(db, { content: "in main", identity });
      addMemory(otherDb, { content: "in other", identity: { projectTag: otherTag } });
      expect(statsMemories(db).total).toBe(1);
      expect(statsMemories(otherDb).total).toBe(1);
    } finally {
      otherDb.close();
    }

    const dbs = listProjectDbs(storagePath);
    expect(dbs.map((d) => d.tag).sort()).toEqual([PROJECT_TAG, otherTag].sort());
    for (const entry of dbs) {
      expect(entry.path.endsWith(`${entry.tag}.db`)).toBe(true);
    }
  });

  test("listProjectDbs returns [] for missing dir", () => {
    expect(listProjectDbs(join(storagePath, "does-not-exist"))).toEqual([]);
  });
});

describe("expandHome", () => {
  test("expands ~ and ~/ prefixes", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/mem")).toBe(join(homedir(), "mem"));
  });

  test("leaves absolute paths untouched", () => {
    expect(expandHome("/abs/x")).toBe("/abs/x");
  });
});
